// MCP over Streamable HTTP: JSON-RPC 2.0 on POST /mcp.
//
// The suite speaks the modern (2026-07-28) era: it probes `server/discover`
// first, then calls `tools/list` and `tools/call`. Six tools cover the same
// store the REST surface does, so a repository or issue made over MCP reads
// back over REST with the same ids. Errors follow JSON-RPC: an unknown tool
// is -32602, an unknown method -32601, a body that is not JSON is HTTP 400
// with -32700, and a call without a bearer token is HTTP 401.

import type { Repo, Store } from './store.ts';
import { repoGlobalId } from './store.ts';
import { buildSquashCommit, mergeConflict } from './gitops.ts';
import { parseCommit } from './gitobj.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * The tool list, built once: two `tools/list` answers must hold the same
 * array byte for byte, and a module-level constant guarantees it.
 */
export const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Handle one POST /mcp body. Returns the HTTP status and the JSON body to
 * send (null sends an empty body, for notifications). Auth is enforced by
 * the HTTP layer before this runs; a body that is not JSON is answered here
 * with HTTP 400 and -32700 before anything else is read.
 */
export function handleMcpBody(store: Store, rawBody: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  // A notification (no id) gets no answer.
  if (request.id === undefined) return { status: 202, body: null };

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2026-07-28';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    return { status: 200, body: callTool(store, id, request.params) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

function callTool(store: Store, id: unknown, params: unknown): Record<string, unknown> {
  if (!isRecord(params) || typeof params.name !== 'string') {
    return rpcError(id, -32602, 'a tool name is required');
  }
  const name = params.name;
  const args = isRecord(params.arguments) ? params.arguments : {};
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return rpcError(id, -32602, `unknown tool: ${name}`);
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcResult(id, toolError(`missing required argument: ${required}`));
    }
  }
  try {
    const value = runTool(store, name, args);
    return rpcResult(id, toolResult(value));
  } catch (error) {
    return rpcResult(id, toolError(error instanceof Error ? error.message : String(error)));
  }
}

function resolveRepoArg(store: Store, args: Record<string, unknown>): Repo {
  const owner = asString(args.owner);
  const repoName = asString(args.repo ?? args.repository ?? args.name);
  if (owner === '' || repoName === '') throw new Error('an owner and a repository are required');
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) throw new Error(`the repository ${owner}/${repoName} was not found`);
  return repo;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer ?? '';
  return {
    id: repoGlobalId(repo),
    node_id: repoGlobalId(repo),
    databaseId: repo.dbid,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(store: Store, repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function runTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  if (name === 'create_repo') {
    const owner = asString(args.owner);
    const repoName = asString(args.name);
    if (repoName === '') throw new Error('a repository name is required');
    if (owner !== '') store.latchViewer(owner);
    const repo = store.createRepo(
      repoName,
      typeof args.private === 'boolean' ? args.private : false,
      asString(args.description),
    );
    if (repo === null) throw new Error('a repository with that name already exists');
    return repoJson(store, repo);
  }
  if (name === 'get_repo') {
    return repoJson(store, resolveRepoArg(store, args));
  }
  if (name === 'create_issue') {
    const repo = resolveRepoArg(store, args);
    const title = asString(args.title);
    if (title === '') throw new Error('a title is required');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const seq = store.order.take();
    const issue = {
      number,
      title,
      body: asString(args.body),
      state: 'open' as const,
      labels: [] as string[],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.issues.set(number, issue);
    return issueJson(store, repo, issue);
  }
  if (name === 'list_issues') {
    const repo = resolveRepoArg(store, args);
    const state = asString(args.state) === '' ? 'open' : asString(args.state);
    const list = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => b.createdSeq - a.createdSeq);
    return list.map((issue) => issueJson(store, repo, issue));
  }
  if (name === 'create_pull_request') {
    const repo = resolveRepoArg(store, args);
    const head = asString(args.head);
    const base = asString(args.base);
    const title = asString(args.title);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      throw new Error('head and base must name existing branches');
    }
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) {
        throw new Error('a pull request is already open for this head and base');
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
    const pull = {
      number,
      title,
      body: asString(args.body),
      state: 'open' as const,
      head,
      base,
      headSha,
      baseSha,
      baseTreeSha,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.set(number, pull);
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      merged: false,
    };
  }
  if (name === 'merge_pull_request') {
    const repo = resolveRepoArg(store, args);
    const number = asNumber(args.pull_number ?? args.number);
    if (number === null) throw new Error('a pull request number is required');
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new Error(`pull request #${number} was not found`);
    if (pull.merged || pull.state !== 'open') throw new Error('the pull request is not open');
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseTip === undefined || headCommit === undefined) throw new Error('the pull request is not open');
    const headTree = parseCommit(headCommit.data).tree;
    const baseCommit = repo.objects.get(baseTip);
    if (baseCommit === undefined || baseCommit.type !== 'commit') {
      throw new Error('the base branch is missing');
    }
    const currentBaseTree = parseCommit(baseCommit.data).tree;
    if (mergeConflict(repo.objects, pull.baseTreeSha, headTree, currentBaseTree)) {
      throw new Error('the pull request has a merge conflict');
    }
    const timestampSec = Math.floor(store.clock.nowMs / 1000);
    const merged = buildSquashCommit(headTree, baseTip, `${pull.title} (#${pull.number})`, timestampSec);
    repo.objects.set(merged.oid, { type: 'commit', data: merged.data });
    repo.refs.set(`refs/heads/${pull.base}`, merged.oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.clock.nowIso;
    pull.mergeCommitSha = merged.oid;
    pull.updatedSeq = store.order.take();
    return { number: pull.number, merged: true, state: 'closed', sha: merged.oid };
  }
  throw new Error(`unknown tool: ${name}`);
}
