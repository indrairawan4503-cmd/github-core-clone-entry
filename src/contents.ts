// Commits the forge itself builds: file writes and deletes through the
// REST contents API, and squash merges. A contents commit is a real git
// commit object (SHA-1 over the canonical bytes), so a clone sees it exactly
// like a pushed one.

import { buildCommit, hashObject, makeObject, parseCommit, parseTree, type GitObject } from './gitobj.ts';
import { buildTreeForFiles, flattenTree } from './gitops.ts';
import type { Repo } from './store.ts';

export interface FileCommitResult {
  commitSha: string;
  blobSha: string;
  /** True when the file did not exist before this commit. */
  created: boolean;
}

/**
 * Write one file on a branch and commit it. When `branch` names a branch
 * that does not exist yet, the branch is created from the default branch's
 * tip (or from the empty tree when the repository is unborn). When
 * `expectedSha` is given, the file's current blob must match it, or the
 * write is refused with a stale-sha error.
 */
export function commitFile(
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch: string | undefined,
  expectedSha: string | undefined,
  timestampSec: number,
): FileCommitResult {
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branch !== undefined) {
    // A new branch starts from the default branch's tip.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined) repo.refs.set(refName, tip);
  }
  const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = parentTree === null ? new Map() : flattenTree(repo.objects, parentTree);
  const existing = flat.get(path)?.oid;
  if (expectedSha !== undefined) {
    if (existing === undefined || existing.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new StaleShaError(`the blob at ${path} is ${existing ?? 'absent'}, not ${expectedSha}`);
    }
  } else if (existing !== undefined) {
    throw new StaleShaError(`the file at ${path} already exists; an update needs its sha`);
  }
  const blob = makeObject('blob', content);
  repo.objects.set(blob.oid, blob.object);
  const files = new Map<string, string>();
  files.set(path, blob.oid);
  const { treeOid, created } = buildTreeForFiles(repo.objects, parentTree, files);
  for (const object of created) {
    const oid = hashObject(object.type, object.data);
    repo.objects.set(oid, object);
  }
  const commit = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    message,
    timestamp: timestampSec,
  });
  const commitOid = hashObject('commit', commit);
  repo.objects.set(commitOid, { type: 'commit', data: commit });
  repo.refs.set(refName, commitOid);
  return { commitSha: commitOid, blobSha: blob.oid, created: existing === undefined };
}

/** Delete one file on the default branch and commit the removal. */
export function deleteFile(
  repo: Repo,
  path: string,
  message: string,
  expectedSha: string | undefined,
  timestampSec: number,
): { commitSha: string } {
  const refName = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) throw new NotFoundError(`the repository has no ${repo.defaultBranch} branch`);
  const parentTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = flattenTree(repo.objects, parentTree);
  const existing = flat.get(path)?.oid;
  if (existing === undefined) throw new NotFoundError(`no file at ${path}`);
  if (expectedSha !== undefined && existing.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new StaleShaError(`the blob at ${path} is ${existing}, not ${expectedSha}`);
  }
  flat.delete(path);
  const files = new Map<string, string>();
  for (const [filePath, entry] of flat) files.set(filePath, entry.oid);
  const { treeOid, created } = buildTreeForFiles(repo.objects, null, files);
  for (const object of created) {
    const oid = hashObject(object.type, object.data);
    repo.objects.set(oid, object);
  }
  const commit = buildCommit({
    tree: treeOid,
    parents: [tip],
    message,
    timestamp: timestampSec,
  });
  const commitOid = hashObject('commit', commit);
  repo.objects.set(commitOid, { type: 'commit', data: commit });
  repo.refs.set(refName, commitOid);
  return { commitSha: commitOid };
}

/** Resolve a ref name (branch, full sha, or HEAD) to a commit id. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (direct !== undefined) return direct;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) {
    return ref.toLowerCase();
  }
  return null;
}

export class StaleShaError extends Error {}
export class NotFoundError extends Error {}

/** The blob bytes at `path` in the tree of `commitOid`, or null. */
export function readFileAt(
  repo: Repo,
  commitOid: string,
  path: string,
): { blobSha: string; data: Buffer } | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(repo.objects, tree);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return { blobSha: entry.oid, data: blob.data };
}

/** The immediate children of `dir` in the tree of `commitOid`. */
export function readDirAt(
  repo: Repo,
  commitOid: string,
  dir: string,
): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(repo.objects, tree);
  const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!children.has(name)) {
        // The subtree's id is the tree object holding this directory.
        const sub = subtreeOid(repo, tree, `${prefix}${name}`);
        children.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: sub ?? '' });
      }
    }
  }
  return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The tree object id of the directory `dirPath` inside `treeOid`. */
function subtreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const segments = dirPath.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/** All commits reachable from `tip`, newest first (depth-first, parents after children). */
export function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) walk(parent);
  };
  walk(tip);
  return out;
}
