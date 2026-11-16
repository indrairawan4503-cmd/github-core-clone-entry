// Git operations over the store: reachability walks, fetch-set computation
// (wants / haves / shallow / deepen), push validation (fast-forward only),
// tree flattening and diffs, and squash merges.
//
// The fetch rules follow git's: a commit the client already holds in full
// (a have that is not a shallow boundary) hides its whole history; a shallow
// boundary hides nothing below it, because the client never had it.

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import type { Repo } from './store.ts';

export interface FetchPlan {
  /** Objects to send, in a stable order, with their ids. */
  objects: Array<{ oid: string; object: GitObject }>;
  /** Commits that stay shallow after this fetch. */
  shallow: string[];
  /** Former shallow boundaries that are complete now. */
  unshallow: string[];
}

/** Every object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target. */
export function collectReachable(
  objects: Map<string, GitObject>,
  roots: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (root !== ZERO_OID && !seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop() ?? '';
    const object = objects.get(oid);
    if (object === undefined) continue;
    const push = (child: string): void => {
      if (child !== ZERO_OID && !seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    };
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      push(commit.tree);
      for (const parent of commit.parents) push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') push(entry.oid);
      }
    } else if (object.type === 'tag') {
      push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by following parents. */
export function isAncestor(
  objects: Map<string, GitObject>,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() ?? '';
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The object itself plus its tree closure (trees + blobs, tag targets),
 * never following a commit's parents. That is what keeps a shallow fetch
 * shallow: the depth cut is applied to the commit set first, and only the
 * trees of the commits that survive the cut are packed. */
function collectCommitClosure(
  objects: Map<string, GitObject>,
  root: string,
  out: Set<string>,
): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() ?? '';
    if (current === ZERO_OID || out.has(current)) continue;
    const object = objects.get(current);
    if (object === undefined) continue;
    out.add(current);
    if (object.type === 'commit') {
      stack.push(parseCommit(object.data).tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
}

export interface FetchRequest {
  wants: string[];
  haves?: string[];
  /** Shallow boundaries the client already holds. */
  shallow?: string[];
  /** Maximum commit generations from a want, when set. */
  depth?: number;
}

/**
 * Work out what a fetch sends. Commits are included when they are within
 * `depth` of a want (or at any distance when no depth is given), are not
 * already held in full, and are not themselves a have. Objects reachable
 * from a held-in-full have are never re-sent; objects under a shallow
 * boundary are, because the client never had them.
 */
export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const objects = repo.objects;
  const wants = [...new Set(request.wants)].filter((oid) => isObjectId(oid) && oid !== ZERO_OID);
  const haves = new Set((request.haves ?? []).filter((oid) => isObjectId(oid) && oid !== ZERO_OID));
  const shallowHeld = new Set((request.shallow ?? []).filter((oid) => isObjectId(oid)));
  const heldInFull = new Set([...haves].filter((oid) => !shallowHeld.has(oid)));
  const heldObjects = collectReachable(objects, heldInFull);
  const heldCommits = new Set([...heldObjects].filter((oid) => objects.get(oid)?.type === 'commit'));

  // Distances from the wants, following parents (a tag want counts its
  // target commit as distance 0).
  const distance = new Map<string, number>();
  const depth = request.depth;
  const queue: string[] = [];
  const note = (oid: string, dist: number): void => {
    const known = distance.get(oid);
    if (known !== undefined && known <= dist) return;
    distance.set(oid, dist);
    queue.push(oid);
  };
  for (const want of wants) {
    const object = objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') note(want, 0);
    else if (object.type === 'tag') note(parseTag(object.data).object, 0);
  }
  while (queue.length > 0) {
    const oid = queue.shift() ?? '';
    const dist = distance.get(oid) ?? 0;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    // Past the depth cut there is nothing left to include: a parent at
    // distance >= depth is never sent, and its own parents are further
    // still. (Its distance was already recorded by note(), which is all
    // the shallow-info computation needs.)
    if (depth !== undefined && dist >= depth) continue;
    for (const parent of parseCommit(object.data).parents) note(parent, dist + 1);
  }

  const included = new Set<string>();
  for (const [oid, dist] of distance) {
    if (depth !== undefined && dist >= depth) continue;
    if (heldCommits.has(oid)) continue;
    if (haves.has(oid)) continue;
    included.add(oid);
  }

  const wantedObjects = new Set<string>();
  for (const want of wants) {
    const object = objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag' || object.type === 'blob' || object.type === 'tree') {
      if (!heldObjects.has(want)) wantedObjects.add(want);
    }
  }
  const send = new Set<string>();
  for (const oid of included) collectCommitClosure(objects, oid, send);
  for (const oid of wantedObjects) collectCommitClosure(objects, oid, send);
  for (const oid of heldObjects) send.delete(oid);
  // A held commit's own objects stay out even when a shallow boundary made
  // its history visible: the client already has the commit itself.
  for (const oid of haves) send.delete(oid);
  for (const oid of included) send.add(oid);

  const ordered = [...send]
    .sort()
    .map((oid) => ({ oid, object: objects.get(oid) }))
    .filter((entry): entry is { oid: string; object: GitObject } => entry.object !== undefined);

  // Shallow-info: a sent commit whose parent was cut off by depth stays
  // shallow; a request boundary whose parents are all sent (or held in
  // full) is complete now.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of included) {
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const cut = parents.some((parent) => (distance.get(parent) ?? 0) >= depth);
      if (cut) shallow.push(oid);
    }
    for (const boundary of shallowHeld) {
      const object = objects.get(boundary);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const complete = parents.every((parent) => included.has(parent) || heldCommits.has(parent));
      if (complete) unshallow.push(boundary);
    }
  }
  return { objects: ordered, shallow, unshallow };
}

// ---------------------------------------------------------------- push

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack command list. Each command is judged on its own: a
 * mixed push applies the fast-forward refs and refuses the rest, one report
 * line each. A ref never moves for a refused command.
 */
export function applyPush(repo: Repo, commands: readonly PushCommand[]): PushOutcome[] {
  const outcomes: PushOutcome[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const fail = (reason: string): void => {
      outcomes.push({ ref: command.ref, ok: false, reason });
    };
    if (command.oldOid !== current) {
      fail(current === ZERO_OID ? 'remote ref does not exist' : 'non-fast-forward');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      outcomes.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      fail('missing object');
      continue;
    }
    if (current !== ZERO_OID && target.type === 'commit') {
      if (!isAncestor(repo.objects, current, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    if (current !== ZERO_OID && target.type !== 'commit') {
      // A non-commit ref update (tag move) still needs the old value to match,
      // which the check above already proved; allow it.
    }
    repo.refs.set(command.ref, command.newOid);
    outcomes.push({ ref: command.ref, ok: true, reason: '' });
  }
  return outcomes;
}

// ---------------------------------------------------------------- trees and diffs

/** Flatten a tree into path -> entry, recursing into subtrees. */
export function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix = '',
  out: Map<string, TreeEntry> = new Map(),
): Map<string, TreeEntry> {
  const object = objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry);
  }
  return out;
}

/** Build the tree objects for `files` (path -> blob oid) on top of `baseTree`. */
export function buildTreeForFiles(
  objects: Map<string, GitObject>,
  baseTree: string | null,
  files: Map<string, string>,
): { treeOid: string; created: GitObject[] } {
  const created: GitObject[] = [];
  const flat = baseTree === null ? new Map<string, TreeEntry>() : flattenTree(objects, baseTree);
  for (const [path, oid] of files) flat.set(path, { mode: '100644', name: path.split('/').pop() ?? path, oid });
  const buildLevel = (paths: Map<string, TreeEntry>, prefix: string): string => {
    const direct: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, TreeEntry>>();
    for (const [path, entry] of paths) {
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        direct.push({ mode: entry.mode, name: rest, oid: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        let group = subdirs.get(dir);
        if (group === undefined) {
          group = new Map();
          subdirs.set(dir, group);
        }
        group.set(path, entry);
      }
    }
    for (const [dir, group] of [...subdirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const subOid = buildLevel(group, prefix === '' ? dir : `${prefix}/${dir}`);
      direct.push({ mode: '40000', name: dir, oid: subOid });
    }
    const data = buildTree(direct);
    const oid = hashObject('tree', data);
    const object: GitObject = { type: 'tree', data };
    created.push(object);
    return oid;
  };
  const treeOid = buildLevel(flat, '');
  return { treeOid, created };
}

/** Split bytes into lines the way a diff counts them. */
export function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest common subsequence length of two line lists (small files only). */
function lcsLength(a: string[], b: string[]): number {
  const rows = new Array<number>(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    let prev = 0;
    for (let j = 0; j < b.length; j += 1) {
      const temp = rows[j + 1] ?? 0;
      rows[j + 1] = a[i] === b[j] ? prev + 1 : Math.max(rows[j + 1] ?? 0, rows[j] ?? 0);
      prev = temp;
    }
  }
  return rows[b.length] ?? 0;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two flattened trees into per-file change records. */
export function diffTrees(
  objects: Map<string, GitObject>,
  base: Map<string, TreeEntry>,
  head: Map<string, TreeEntry>,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from === undefined && to !== undefined) {
      const blob = objects.get(to.oid);
      const lines = blob === undefined ? 0 : countLines(blob.data).length;
      diffs.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (from !== undefined && to === undefined) {
      const blob = objects.get(from.oid);
      const lines = blob === undefined ? 0 : countLines(blob.data).length;
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const baseBlob = objects.get(from.oid);
      const headBlob = objects.get(to.oid);
      const baseLines = baseBlob === undefined ? [] : countLines(baseBlob.data);
      const headLines = headBlob === undefined ? [] : countLines(headBlob.data);
      const common = lcsLength(baseLines, headLines);
      const additions = headLines.length - common;
      const deletions = baseLines.length - common;
      diffs.push({
        filename: path,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------- merges

/** True when the pull request can merge: no path it changes was also changed on the base since it opened. */
export function mergeConflict(
  objects: Map<string, GitObject>,
  baseTreeAtOpen: string,
  headTree: string,
  currentBaseTree: string,
): boolean {
  const atOpen = flattenTree(objects, baseTreeAtOpen);
  const head = flattenTree(objects, headTree);
  const current = flattenTree(objects, currentBaseTree);
  const changed = diffTrees(objects, atOpen, head);
  for (const change of changed) {
    const then = atOpen.get(change.filename)?.oid ?? null;
    const now = current.get(change.filename)?.oid ?? null;
    if (then !== now) return true;
  }
  return false;
}

/** Build a squash merge commit: the head tree, on top of the current base tip. */
export function buildSquashCommit(
  headTree: string,
  baseTip: string,
  message: string,
  timestampSec: number,
): { data: Buffer; oid: string } {
  const data = buildCommit({
    tree: headTree,
    parents: [baseTip],
    message,
    timestamp: timestampSec,
  });
  return { data, oid: hashObject('commit', data) };
}
