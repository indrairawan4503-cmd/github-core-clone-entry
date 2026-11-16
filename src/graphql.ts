// GraphQL over the same store: the 18 documents the suite sends (gh and
// github-mcp-server shapes), plus Relay global ids and cursor pagination.
//
// The parser covers the subset the suite uses: one operation per document,
// named arguments with literals, variables, lists and input objects, field
// aliases and inline fragments. Unknown fields are reported in `errors`
// with HTTP 200, exactly as a real GraphQL server answers them.

import { diffTrees, flattenTree, mergeConflict, buildSquashCommit } from './gitops.ts';
import { parseCommit } from './gitobj.ts';
import {
  commentGlobalId,
  decodeIssueGlobalId,
  decodePullGlobalId,
  decodeRepoGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- parser

interface FieldNode {
  /** Response key: the alias when present, else the field name. */
  key: string;
  name: string;
  args: Record<string, unknown>;
  children: FieldNode[] | null;
  /** Inline fragment type condition, when this node is a fragment spread. */
  fragmentOn: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  fields: FieldNode[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'var'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] ?? '')) j += 1;
      tokens.push({ kind: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] ?? '')) j += 1;
      const text = source.slice(i, j);
      if (text.includes('.') || text.includes('e') || text.includes('E')) {
        tokens.push({ kind: 'float', value: Number(text) });
      } else {
        tokens.push({ kind: 'int', value: Number(text) });
      }
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document`);
    }
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      // Optional operation name.
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') this.next();
      // Optional variable definitions: ($name: Type, ...).
      if (this.atPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, fields };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    const token = this.next();
    if (token.kind === 'spread') {
      // `... on Type { ... }` (named fragments are not used by the suite).
      const on = this.next();
      if (on.kind !== 'name' || on.value !== 'on') throw new Error('expected `on` after `...`');
      const typeName = this.next();
      if (typeName.kind !== 'name') throw new Error('expected a type name after `on`');
      const children = this.parseSelectionSet();
      return { key: '', name: '', args: {}, children, fragmentOn: typeName.value };
    }
    if (token.kind !== 'name') throw new Error('expected a field name');
    let key = token.value;
    let name = token.value;
    if (this.atPunct(':')) {
      this.next();
      const real = this.next();
      if (real.kind !== 'name') throw new Error('expected a field name after an alias');
      name = real.value;
    }
    let args: Record<string, unknown> = {};
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args[argName.value] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let children: FieldNode[] | null = null;
    if (this.atPunct('{')) children = this.parseSelectionSet();
    return { key, name, args, children, fragmentOn: null };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'var') return this.variables[token.value];
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int' || token.kind === 'float') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!this.atPunct('}')) {
        const field = this.next();
        if (field.kind !== 'name') throw new Error('expected an input object field name');
        this.expectPunct(':');
        object[field.value] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- schema tables

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'mergedAt', 'files', 'headRef', 'baseRef', 'author', 'url',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
  ],
  User: ['login', 'id', 'name'],
  IssueComment: ['id', 'body', 'author'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE'],
};

// ---------------------------------------------------------------- values

type GqlValue =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; endCursor: string | null; hasNextPage: boolean }
  | { __type: 'PullRequestConnection'; pulls: PullRequest[]; repo: Repo }
  | { __type: 'FileConnection'; files: Array<{ path: string }> }
  | { __type: 'TypeInfo'; name: string }
  | { __type: 'TypeField'; name: string }
  | { __type: 'File'; path: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'CommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'Comment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | null;

interface Executor {
  store: Store;
  errors: Array<{ message: string }>;
}

function typeOf(value: GqlValue): string {
  if (value === null) return 'Null';
  return value.__type;
}

// ---------------------------------------------------------------- execution

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one operation document. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
): GraphQLResult {
  const executor: Executor = { store, errors: [] };
  let operation: Operation;
  try {
    operation = new Parser(tokenize(query), variables).parseOperation();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const data: Record<string, unknown> = {};
  for (const field of operation.fields) {
    data[field.key] = executeField(executor, operation.kind === 'mutation' ? 'Mutation' : 'Query', null, field);
  }
  return executor.errors.length > 0 ? { data, errors: executor.errors } : { data };
}

function executeField(
  executor: Executor,
  parentType: string,
  parent: GqlValue,
  field: FieldNode,
): unknown {
  if (field.fragmentOn !== null) {
    if (field.fragmentOn !== parentType) return undefined;
    if (field.children === null) return undefined;
    const merged: Record<string, unknown> = {};
    for (const child of field.children) {
      merged[child.key] = executeField(executor, parentType, parent, child);
    }
    return merged;
  }
  const resolver = resolvers(parentType, field.name);
  if (resolver === undefined) {
    executor.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  const value = resolver(executor, parent, field.args);
  if (field.children === null) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => selectFields(executor, entry, field.children ?? []));
  }
  return selectFields(executor, value as GqlValue, field.children);
}

function selectFields(executor: Executor, value: GqlValue, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const valueType = typeOf(value);
  for (const child of children) {
    // A fragment spread merges its fields into this object when the type fits.
    if (child.fragmentOn !== null) {
      if (child.fragmentOn === valueType && child.children !== null) {
        for (const grand of child.children) {
          out[grand.key] = executeField(executor, valueType, value, grand);
        }
      }
      continue;
    }
    out[child.key] = executeField(executor, valueType, value, child);
  }
  return out;
}

type Resolver = (executor: Executor, parent: GqlValue, args: Record<string, unknown>) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolvers(parentType: string, field: string): Resolver | undefined {
  const table: Record<string, Record<string, Resolver>> = {
    Query: {
      viewer: (executor) => {
        const login = executor.store.viewer;
        return login === null ? null : { __type: 'User', login };
      },
      repository: (executor, _parent, args) => {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = executor.store.resolveRepo(owner, name);
        return repo === null ? null : { __type: 'Repository', repo };
      },
      node: (executor, _parent, args) => {
        const id = typeof args.id === 'string' ? args.id : '';
        const repoDbid = decodeRepoGlobalId(id);
        if (repoDbid !== null) {
          const repo = executor.store.repoByDbid(repoDbid);
          return repo === null ? null : { __type: 'Repository', repo };
        }
        const issueRef = decodeIssueGlobalId(id);
        if (issueRef !== null) {
          const repo = executor.store.repoByDbid(issueRef.dbid);
          const issue = repo?.issues.get(issueRef.number);
          return repo === undefined || issue === undefined ? null : { __type: 'Issue', repo, issue };
        }
        const pullRef = decodePullGlobalId(id);
        if (pullRef !== null) {
          const repo = executor.store.repoByDbid(pullRef.dbid);
          const pull = repo?.pulls.get(pullRef.number);
          return repo === undefined || pull === undefined ? null : { __type: 'PullRequest', repo, pull };
        }
        return null;
      },
      __type: (_executor, _parent, args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        return { __type: 'TypeInfo', name };
      },
    },
    Mutation: {
      createIssue: (executor, _parent, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const dbid = typeof input.repositoryId === 'string' ? decodeRepoGlobalId(input.repositoryId) : null;
        const repo = dbid === null ? null : executor.store.repoByDbid(dbid);
        if (repo === null) throw new MutationError('the repository was not found');
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') throw new MutationError('a title is required');
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const seq = executor.store.order.take();
        const issue: Issue = {
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdSeq: seq,
          updatedSeq: seq,
        };
        repo.issues.set(number, issue);
        return { __type: 'CreateIssuePayload', repo, issue };
      },
      closeIssue: (executor, _parent, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const ref = typeof input.issueId === 'string' ? decodeIssueGlobalId(input.issueId) : null;
        const repo = ref === null ? null : executor.store.repoByDbid(ref.dbid);
        const issue = repo?.issues.get(ref?.number ?? -1);
        if (repo === undefined || repo === null || issue === undefined) {
          throw new MutationError('the issue was not found');
        }
        issue.state = 'closed';
        issue.updatedSeq = executor.store.order.take();
        return { __type: 'CloseIssuePayload', repo, issue };
      },
      createPullRequest: (executor, _parent, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const dbid = typeof input.repositoryId === 'string' ? decodeRepoGlobalId(input.repositoryId) : null;
        const repo = dbid === null ? null : executor.store.repoByDbid(dbid);
        if (repo === null) throw new MutationError('the repository was not found');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined || title === '') {
          throw new MutationError('head and base must name existing branches');
        }
        for (const pull of repo.pulls.values()) {
          if (pull.state === 'open' && pull.head === head && pull.base === base) {
            throw new MutationError('a pull request is already open for this head and base');
          }
        }
        const baseCommit = repo.objects.get(baseSha);
        const baseTreeSha =
          baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const seq = executor.store.order.take();
        const pull: PullRequest = {
          number,
          title,
          body: '',
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
        return { __type: 'CreatePullRequestPayload', repo, pull };
      },
      mergePullRequest: (executor, _parent, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const ref = typeof input.pullRequestId === 'string' ? decodePullGlobalId(input.pullRequestId) : null;
        const repo = ref === null ? null : executor.store.repoByDbid(ref.dbid);
        const pull = repo?.pulls.get(ref?.number ?? -1);
        if (repo === undefined || repo === null || pull === undefined) {
          throw new MutationError('the pull request was not found');
        }
        if (pull.merged || pull.state !== 'open') throw new MutationError('the pull request is not open');
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        const headCommit = repo.objects.get(pull.headSha);
        if (baseTip === undefined || headCommit === undefined) throw new MutationError('the pull request is not open');
        const headTree = parseCommit(headCommit.data).tree;
        const baseCommit = repo.objects.get(baseTip);
        if (baseCommit === undefined || baseCommit.type !== 'commit') {
          throw new MutationError('the base branch is missing');
        }
        const currentBaseTree = parseCommit(baseCommit.data).tree;
        if (mergeConflict(repo.objects, pull.baseTreeSha, headTree, currentBaseTree)) {
          throw new MutationError('the pull request has a merge conflict');
        }
        const timestampSec = Math.floor(executor.store.clock.nowMs / 1000);
        const merged = buildSquashCommit(headTree, baseTip, `${pull.title} (#${pull.number})`, timestampSec);
        repo.objects.set(merged.oid, { type: 'commit', data: merged.data });
        repo.refs.set(`refs/heads/${pull.base}`, merged.oid);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = executor.store.clock.nowIso;
        pull.mergeCommitSha = merged.oid;
        pull.updatedSeq = executor.store.order.take();
        return { __type: 'MergePullRequestPayload', repo, pull };
      },
      addComment: (executor, _parent, args) => {
        const input = isRecord(args.input) ? args.input : {};
        const ref = typeof input.subjectId === 'string' ? decodeIssueGlobalId(input.subjectId) : null;
        const repo = ref === null ? null : executor.store.repoByDbid(ref.dbid);
        const issue = repo?.issues.get(ref?.number ?? -1);
        if (repo === undefined || repo === null || issue === undefined) {
          throw new MutationError('the issue was not found');
        }
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = { id: executor.store.commentIds.take(), body, createdSeq: executor.store.order.take() };
        issue.comments.push(comment);
        return { __type: 'AddCommentPayload', repo, issue, comment };
      },
    },
    User: {
      login: (_executor, parent) => (parent !== null && parent.__type === 'User' ? parent.login : null),
      id: (_executor, parent) =>
        parent !== null && parent.__type === 'User'
          ? Buffer.from(`User:${parent.login}`, 'utf8').toString('base64')
          : null,
    },
    Repository: {
      id: (_executor, parent) => (parent !== null && parent.__type === 'Repository' ? repoGlobalId(parent.repo) : null),
      databaseId: (_executor, parent) =>
        parent !== null && parent.__type === 'Repository' ? parent.repo.dbid : null,
      name: (_executor, parent) => (parent !== null && parent.__type === 'Repository' ? parent.repo.name : null),
      nameWithOwner: (_executor, parent) =>
        parent !== null && parent.__type === 'Repository'
          ? `${parent.repo.owner ?? ''}/${parent.repo.name}`
          : null,
      owner: (_executor, parent) =>
        parent !== null && parent.__type === 'Repository'
          ? { __type: 'User', login: parent.repo.owner ?? '' }
          : null,
      defaultBranchRef: (_executor, parent) => {
        if (parent === null || parent.__type !== 'Repository') return null;
        if (!parent.repo.refs.has(`refs/heads/${parent.repo.defaultBranch}`)) return null;
        return { __type: 'Ref', name: parent.repo.defaultBranch };
      },
      viewerPermission: () => 'ADMIN',
      hasIssuesEnabled: () => true,
      description: (_executor, parent) =>
        parent !== null && parent.__type === 'Repository' ? parent.repo.description : null,
      issue: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'Repository') return null;
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = parent.repo.issues.get(number);
        return issue === undefined ? null : { __type: 'Issue', repo: parent.repo, issue };
      },
      issues: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'Repository') return null;
        return issueConnection(parent.repo, args);
      },
      pullRequest: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'Repository') return null;
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = parent.repo.pulls.get(number);
        return pull === undefined ? null : { __type: 'PullRequest', repo: parent.repo, pull };
      },
      pullRequests: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'Repository') return null;
        const first = typeof args.first === 'number' ? args.first : 30;
        const pulls = [...parent.repo.pulls.values()]
          .filter((pull) => pull.state === 'open')
          .sort((a, b) => a.createdSeq - b.createdSeq)
          .slice(0, first);
        return { __type: 'PullRequestConnection', pulls, repo: parent.repo };
      },
    },
    Ref: {
      name: (_executor, parent) => (parent !== null && parent.__type === 'Ref' ? parent.name : null),
    },
    Issue: {
      id: (_executor, parent) =>
        parent !== null && parent.__type === 'Issue' ? issueGlobalId(parent.repo, parent.issue.number) : null,
      number: (_executor, parent) => (parent !== null && parent.__type === 'Issue' ? parent.issue.number : null),
      title: (_executor, parent) => (parent !== null && parent.__type === 'Issue' ? parent.issue.title : null),
      body: (_executor, parent) => (parent !== null && parent.__type === 'Issue' ? parent.issue.body : null),
      state: (_executor, parent) =>
        parent !== null && parent.__type === 'Issue'
          ? parent.issue.state === 'open'
            ? 'OPEN'
            : 'CLOSED'
          : null,
    },
    PullRequest: {
      id: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? pullGlobalId(parent.repo, parent.pull.number) : null,
      number: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? parent.pull.number : null,
      title: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? parent.pull.title : null,
      body: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? parent.pull.body : null,
      state: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest'
          ? parent.pull.state === 'open'
            ? 'OPEN'
            : 'CLOSED'
          : null,
      headRefName: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? parent.pull.head : null,
      baseRefName: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? parent.pull.base : null,
      merged: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequest' ? parent.pull.merged : null,
      mergeable: (_executor, parent) => {
        if (parent === null || parent.__type !== 'PullRequest') return null;
        if (parent.pull.merged || parent.pull.state !== 'open') return 'UNKNOWN';
        const baseTip = parent.repo.refs.get(`refs/heads/${parent.pull.base}`);
        const headCommit = parent.repo.objects.get(parent.pull.headSha);
        if (baseTip === undefined || headCommit === undefined) return 'UNKNOWN';
        const headTree = parseCommit(headCommit.data).tree;
        const baseCommit = parent.repo.objects.get(baseTip);
        if (baseCommit === undefined || baseCommit.type !== 'commit') return 'UNKNOWN';
        const currentBaseTree = parseCommit(baseCommit.data).tree;
        return mergeConflict(parent.repo.objects, parent.pull.baseTreeSha, headTree, currentBaseTree)
          ? 'CONFLICTING'
          : 'MERGEABLE';
      },
      files: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'PullRequest') return null;
        const first = typeof args.first === 'number' ? args.first : 30;
        const headCommit = parent.repo.objects.get(parent.pull.headSha);
        const baseCommit = parent.repo.objects.get(parent.pull.baseSha);
        if (headCommit === undefined || baseCommit === undefined) {
          return { __type: 'FileConnection', files: [] };
        }
        const headTree = parseCommit(headCommit.data).tree;
        const baseTree = parseCommit(baseCommit.data).tree;
        const diffs = diffTrees(
          parent.repo.objects,
          flattenTree(parent.repo.objects, baseTree),
          flattenTree(parent.repo.objects, headTree),
        );
        return {
          __type: 'FileConnection',
          files: diffs.slice(0, first).map((diff) => ({ path: diff.filename })),
        };
      },
    },
    IssueConnection: {
      nodes: (_executor, parent) =>
        parent !== null && parent.__type === 'IssueConnection'
          ? parent.issues.map((issue) => ({ __type: 'Issue', repo: parent.repo, issue }) as GqlValue)
          : null,
      pageInfo: (_executor, parent) =>
        parent !== null && parent.__type === 'IssueConnection'
          ? { __type: 'PageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor }
          : null,
    },
    PullRequestConnection: {
      nodes: (_executor, parent) =>
        parent !== null && parent.__type === 'PullRequestConnection'
          ? parent.pulls.map((pull) => ({ __type: 'PullRequest', repo: parent.repo, pull }) as GqlValue)
          : null,
    },
    FileConnection: {
      nodes: (_executor, parent) =>
        parent !== null && parent.__type === 'FileConnection'
          ? parent.files.map((file) => ({ __type: 'File', path: file.path }) as unknown as GqlValue)
          : null,
    },
    File: {
      path: (_executor, parent) => {
        const value = parent as unknown as { path?: string } | null;
        return value?.path ?? null;
      },
    },
    PageInfo: {
      hasNextPage: (_executor, parent) => {
        const value = parent as unknown as { hasNextPage?: boolean } | null;
        return value?.hasNextPage ?? null;
      },
      endCursor: (_executor, parent) => {
        const value = parent as unknown as { endCursor?: string | null } | null;
        return value?.endCursor ?? null;
      },
    },
    TypeInfo: {
      name: (_executor, parent) => (parent !== null && parent.__type === 'TypeInfo' ? parent.name : null),
      fields: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'TypeInfo') return null;
        const names = TYPE_FIELDS[parent.name] ?? [];
        void args;
        return names.map((name) => ({ __type: 'TypeField', name }) as unknown as GqlValue);
      },
      enumValues: (_executor, parent, args) => {
        if (parent === null || parent.__type !== 'TypeInfo') return null;
        const names = TYPE_ENUM_VALUES[parent.name] ?? [];
        void args;
        return names.map((name) => ({ __type: 'TypeField', name }) as unknown as GqlValue);
      },
    },
    TypeField: {
      name: (_executor, parent) => {
        const value = parent as unknown as { name?: string } | null;
        return value?.name ?? null;
      },
    },
    CommentEdge: {
      node: (_executor, parent) =>
        parent !== null && parent.__type === 'CommentEdge'
          ? ({ __type: 'Comment', repo: parent.repo, issue: parent.issue, comment: parent.comment } as GqlValue)
          : null,
    },
    Comment: {
      id: (_executor, parent) =>
        parent !== null && parent.__type === 'Comment'
          ? commentGlobalId(parent.repo, parent.issue.number, parent.comment.id)
          : null,
      body: (_executor, parent) =>
        parent !== null && parent.__type === 'Comment' ? parent.comment.body : null,
    },
    CreateIssuePayload: {
      issue: (_executor, parent) =>
        parent !== null && parent.__type === 'CreateIssuePayload'
          ? ({ __type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue)
          : null,
    },
    CloseIssuePayload: {
      issue: (_executor, parent) =>
        parent !== null && parent.__type === 'CloseIssuePayload'
          ? ({ __type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue)
          : null,
    },
    CreatePullRequestPayload: {
      pullRequest: (_executor, parent) =>
        parent !== null && parent.__type === 'CreatePullRequestPayload'
          ? ({ __type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue)
          : null,
    },
    MergePullRequestPayload: {
      pullRequest: (_executor, parent) =>
        parent !== null && parent.__type === 'MergePullRequestPayload'
          ? ({ __type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue)
          : null,
    },
    AddCommentPayload: {
      commentEdge: (_executor, parent) =>
        parent !== null && parent.__type === 'AddCommentPayload'
          ? ({ __type: 'CommentEdge', repo: parent.repo, issue: parent.issue, comment: parent.comment } as GqlValue)
          : null,
    },
  };
  const byType = table[parentType];
  if (byType === undefined) return undefined;
  return byType[field];
}

class MutationError extends Error {}

/** One issues connection: state filter, creation order, cursor paging. */
function issueConnection(
  repo: Repo,
  args: Record<string, unknown>,
): { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; endCursor: string | null; hasNextPage: boolean } {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = typeof args.after === 'string' ? args.after : null;
  const states = Array.isArray(args.states) ? (args.states as unknown[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  let list = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(
      states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : '')),
    );
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
  let start = 0;
  if (after !== null) {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(text);
      if (match !== null) {
        const afterNumber = Number(match[1]);
        const index = list.findIndex((issue) => issue.number === afterNumber);
        start = index < 0 ? list.length : index + 1;
      }
    } catch {
      start = list.length;
    }
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor =
    page.length === 0 ? null : Buffer.from(`cursor:${page[page.length - 1]?.number ?? 0}`, 'utf8').toString('base64');
  return { __type: 'IssueConnection', repo, issues: page, endCursor, hasNextPage };
}

/** Handle one GraphQL HTTP body (a single operation or a batch array). */
export function handleGraphQLBody(store: Store, rawBody: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'the request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): GraphQLResult => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'a query document is required' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    try {
      return executeGraphQL(store, entry.query, variables);
    } catch (error) {
      if (error instanceof MutationError) {
        return { data: null, errors: [{ message: error.message }] };
      }
      return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
