// The REST v3 surface: repositories, branches, commits, contents, git refs,
// labels, issues, pull requests and the protocol rules (JSON everywhere, a
// request id on every reply, JSON 404s, a 400 for a malformed body).
//
// Every handler is a pure function of the store: no clock reads, no random
// ids, so the same requests always produce the same answers.

import {
  commitFile,
  deleteFile,
  listCommits,
  readDirAt,
  readFileAt,
  resolveRef,
  NotFoundError,
  StaleShaError,
} from './contents.ts';
import {
  buildSquashCommit,
  diffTrees,
  flattenTree,
  mergeConflict,
} from './gitops.ts';
import { hashObject, isObjectId, parseCommit, parseIdentity } from './gitobj.ts';
import {
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after `/api/v3`. */
  segments: string[];
  query: URLSearchParams;
  /** The raw request body (empty when there is none). */
  rawBody: Buffer;
  /** The request's Host header, for absolute pagination links. */
  host: string;
}

export interface RestResponse {
  status: number;
  /** Serialized as JSON; null sends an empty body (used for 204). */
  body: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

export class BadJsonError extends Error {}

/** Parse a request body as JSON; an empty body is undefined. */
function jsonBody(req: RestRequest): unknown {
  const text = req.rawBody.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadJsonError('the request body is not valid JSON');
  }
}

function asObject(value: unknown): Json {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Json;
  return {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- views

function repoView(store: Store, repo: Repo): Json {
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: repoGlobalId(repo),
    node_id: repoGlobalId(repo),
    databaseId: repo.dbid,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.dbid, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: store.clock.nowIso,
    updated_at: store.clock.nowIso,
    has_issues: true,
  };
}

function issueView(store: Store, repo: Repo, issue: Issue): Json {
  return {
    id: issueGlobalId(repo, issue.number),
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner ?? store.viewer ?? '', type: 'User' },
    created_at: store.clock.nowIso,
    updated_at: store.clock.nowIso,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function commentView(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string }): Json {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue.number, comment.id),
    body: comment.body,
    user: { login: repo.owner ?? store.viewer ?? '', type: 'User' },
    created_at: store.clock.nowIso,
    updated_at: store.clock.nowIso,
  };
}

function pullView(store: Store, repo: Repo, pull: PullRequest): Json {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: pullGlobalId(repo, pull.number),
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: store.clock.nowIso,
    updated_at: store.clock.nowIso,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(all: T[], req: RestRequest, basePath: string): Page<T> {
  const rawPerPage = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, Math.trunc(rawPerPage))) : 30;
  const rawPage = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const link =
    start + perPage < all.length
      ? `<http://${req.host}${basePath}?per_page=${perPage}&page=${page + 1}>; rel="next"`
      : null;
  return { items, link };
}

function withLink(response: RestResponse, link: string | null): RestResponse {
  if (link === null) return response;
  return { ...response, headers: { ...(response.headers ?? {}), link } };
}

// ---------------------------------------------------------------- routing

/** Dispatch one REST request. Auth is enforced by the HTTP layer. */
export function handleRest(store: Store, req: RestRequest): RestResponse {
  try {
    return route(store, req);
  } catch (error) {
    if (error instanceof BadJsonError) return err(400, error.message);
    if (error instanceof StaleShaError) return err(409, error.message);
    if (error instanceof NotFoundError) return err(404, error.message);
    return err(500, `internal error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function route(store: Store, req: RestRequest): RestResponse {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      return ok(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return err(404, 'Not Found');
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') {
      if (store.viewer === null) return err(404, 'Not Found');
      return ok(200, { login: store.viewer, id: 1, type: 'User' });
    }
    return err(404, 'Not Found');
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const page = paginate(store.viewerRepos(), req, '/api/v3/user/repos');
      return withLink(ok(200, page.items.map((repo) => repoView(store, repo))), page.link);
    }
    if (method === 'POST') {
      const body = asObject(jsonBody(req));
      const name = asString(body.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return err(422, 'a repository name is required');
      }
      const repo = store.createRepo(name, asBoolean(body.private, false), asString(body.description));
      if (repo === null) return err(422, 'a repository with that name already exists');
      return ok(201, repoView(store, repo));
    }
    return err(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return err(404, 'Not Found');
  const owner = seg[1] ?? '';
  const name = seg[2] ?? '';
  const rest = seg.slice(3);

  // Every repository route latches the viewer from its owner segment.
  const repo = store.resolveRepo(owner, name);
  if (repo === null) return err(404, 'Not Found');

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoView(store, repo));
    if (method === 'PATCH') {
      const body = asObject(jsonBody(req));
      if (typeof body.description === 'string') repo.description = body.description;
      return ok(200, repoView(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref) ?? '' },
        }));
      return ok(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = rest[1] ?? '';
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const sha = req.query.get('sha') ?? undefined;
    const tip = resolveRef(repo, sha);
    if (tip === null) return err(404, 'Not Found');
    const commits = listCommits(repo, tip).map((entry) => {
      const object = repo.objects.get(entry.sha);
      const parsed = object === undefined ? null : parseCommit(object.data);
      const author = parsed === null ? { name: '', email: '', date: '' } : parseIdentity(parsed.author);
      const committer = parsed === null ? { name: '', email: '', date: '' } : parseIdentity(parsed.committer);
      return {
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
        },
      };
    });
    return ok(200, commits);
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (path === '') return err(404, 'Not Found');
    if (method === 'GET') return getContents(store, repo, path, req.query.get('ref') ?? undefined);
    if (method === 'PUT') return putContents(store, repo, path, req);
    if (method === 'DELETE') return deleteContents(store, repo, path, req);
    return err(404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = asObject(jsonBody(req));
      const ref = asString(body.ref);
      const sha = asString(body.sha).toLowerCase();
      if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'a ref and a valid sha are required');
      if (repo.refs.has(ref)) return err(422, 'the ref already exists');
      if (!repo.objects.has(sha)) return err(422, 'the sha is not an object in this repository');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (rest.length === 1 && method === 'POST') {
      const body = asObject(jsonBody(req));
      const labelName = asString(body.name);
      if (labelName === '') return err(422, 'a label name is required');
      if (repo.labels.has(labelName)) return err(422, 'the label already exists');
      const color = asString(body.color) === '' ? 'ededed' : asString(body.color);
      repo.labels.set(labelName, { name: labelName, color });
      return ok(201, { name: labelName, color });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'issues') return issuesRoute(store, repo, rest.slice(1), req);
  if (rest[0] === 'pulls') return pullsRoute(store, repo, rest.slice(1), req);
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function getContents(store: Store, repo: Repo, path: string, ref: string | undefined): RestResponse {
  const tip = resolveRef(repo, ref);
  if (tip === null) return err(404, 'Not Found');
  const file = readFileAt(repo, tip, path);
  if (file !== null) {
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: file.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: file.data.toString('base64'),
      sha: file.blobSha,
    });
  }
  const dir = readDirAt(repo, tip, path);
  if (dir !== null && dir.length > 0) {
    return ok(
      200,
      dir.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha })),
    );
  }
  return err(404, 'Not Found');
}

function putContents(store: Store, repo: Repo, path: string, req: RestRequest): RestResponse {
  const body = asObject(jsonBody(req));
  const message = asString(body.message);
  const content = asString(body.content);
  if (message === '' || content === '') return err(422, 'a message and base64 content are required');
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const timestampSec = Math.floor(store.clock.nowMs / 1000);
  const result = commitFile(repo, path, Buffer.from(content, 'base64'), message, branch, sha, timestampSec);
  return ok(result.created ? 201 : 200, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: result.blobSha,
      size: Buffer.from(content, 'base64').length,
      encoding: 'base64',
    },
    commit: { sha: result.commitSha, message },
  });
}

function deleteContents(store: Store, repo: Repo, path: string, req: RestRequest): RestResponse {
  const body = asObject(jsonBody(req));
  const message = asString(body.message);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const timestampSec = Math.floor(store.clock.nowMs / 1000);
  const result = deleteFile(repo, path, message === '' ? 'delete' : message, sha, timestampSec);
  return ok(200, { commit: { sha: result.commitSha } });
}

// ---------------------------------------------------------------- issues

function issuesRoute(store: Store, repo: Repo, rest: string[], req: RestRequest): RestResponse {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const page = paginate(list, req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return withLink(ok(200, page.items.map((issue) => issueView(store, repo, issue))), page.link);
    }
    if (method === 'POST') {
      const body = asObject(jsonBody(req));
      const title = asString(body.title);
      if (title === '') return err(422, 'a title is required');
      const labelNames: string[] = Array.isArray(body.labels)
        ? (body.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
      for (const label of labelNames) {
        if (!repo.labels.has(label)) return err(422, `the label ${label} does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const seq = store.order.take();
      const issue: Issue = {
        number,
        title,
        body: asString(body.body),
        state: 'open',
        labels: labelNames,
        comments: [],
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.issues.set(number, issue);
      return ok(201, issueView(store, repo, issue));
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, issueView(store, repo, issue));
    if (method === 'PATCH') {
      const body = asObject(jsonBody(req));
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedSeq = store.order.take();
      return ok(200, issueView(store, repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => commentView(store, repo, issue, comment)));
    }
    if (method === 'POST') {
      const body = asObject(jsonBody(req));
      const text = asString(body.body);
      if (text === '') return err(422, 'a comment body is required');
      const comment = { id: store.commentIds.take(), body: text, createdSeq: store.order.take() };
      issue.comments.push(comment);
      return ok(201, commentView(store, repo, issue, comment));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function pullsRoute(store: Store, repo: Repo, rest: string[], req: RestRequest): RestResponse {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => a.createdSeq - b.createdSeq);
      const page = paginate(list, req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return withLink(ok(200, page.items.map((pull) => pullView(store, repo, pull))), page.link);
    }
    if (method === 'POST') {
      const body = asObject(jsonBody(req));
      const head = asString(body.head);
      const base = asString(body.base);
      const title = asString(body.title);
      if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return err(422, 'head and base must name existing branches');
      }
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.head === head && pull.base === base) {
          return err(422, 'a pull request is already open for this head and base');
        }
      }
      const baseCommit = repo.objects.get(baseSha);
      const baseTreeSha =
        baseCommit !== undefined && baseCommit.type === 'commit'
          ? parseCommit(baseCommit.data).tree
          : '';
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const seq = store.order.take();
      const pull: PullRequest = {
        number,
        title,
        body: asString(body.body),
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        baseTreeSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.pulls.set(number, pull);
      return ok(201, pullView(store, repo, pull));
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullView(store, repo, pull));
    return err(404, 'Not Found');
  }

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const headCommit = repo.objects.get(pull.headSha);
    const baseCommit = repo.objects.get(pull.baseSha);
    if (headCommit === undefined || baseCommit === undefined) return err(404, 'Not Found');
    const headTree = parseCommit(headCommit.data).tree;
    const baseTree = parseCommit(baseCommit.data).tree;
    const files = diffTrees(
      repo.objects,
      flattenTree(repo.objects, baseTree),
      flattenTree(repo.objects, headTree),
    );
    return ok(
      200,
      files.map((file) => ({
        filename: file.filename,
        status: file.status === 'removed' ? 'removed' : file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    );
  }

  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    if (pull.merged) return err(405, 'the pull request is already merged');
    if (pull.state !== 'open') return err(405, 'the pull request is not open');
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseTip === undefined || headCommit === undefined) return err(404, 'Not Found');
    const headTree = parseCommit(headCommit.data).tree;
    const baseCommit = repo.objects.get(baseTip);
    if (baseCommit === undefined || baseCommit.type !== 'commit') return err(404, 'Not Found');
    const currentBaseTree = parseCommit(baseCommit.data).tree;
    if (mergeConflict(repo.objects, pull.baseTreeSha, headTree, currentBaseTree)) {
      return err(405, 'the pull request has a merge conflict');
    }
    const timestampSec = Math.floor(store.clock.nowMs / 1000);
    const merged = buildSquashCommit(
      headTree,
      baseTip,
      `${pull.title} (#${pull.number})`,
      timestampSec,
    );
    repo.objects.set(merged.oid, { type: 'commit', data: merged.data });
    repo.refs.set(`refs/heads/${pull.base}`, merged.oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.clock.nowIso;
    pull.mergeCommitSha = merged.oid;
    pull.updatedSeq = store.order.take();
    return ok(200, {
      sha: merged.oid,
      merged: true,
      message: `Pull request #${pull.number} merged`,
    });
  }
  return err(404, 'Not Found');
}
