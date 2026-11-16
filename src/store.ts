// The forge's store: everything lives in memory, in plain Maps.
//
// One process, one trial: repos are created, pushed to and read back by the
// same process, so an in-memory store is both the fastest and the most
// faithful option. Nothing is written to disk; a replay starts from an empty
// store and the same requests rebuild the same state.
//
// The token names one login, but the server cannot decode that login from
// the token: it latches the viewer from the first owner-bearing request.
// Repositories created before the latch adopt the latched owner. After the
// latch, any other owner is a 404, never a 403.

import { Sequence, type TrialClock } from './clock.ts';
import { type GitObject } from './gitobj.ts';

export interface RepoLabel {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** The head branch tip when the pull request was opened. */
  headSha: string;
  /** The base branch tip when the pull request was opened. */
  baseSha: string;
  /** The base branch's tree when the pull request was opened (conflict rule). */
  baseTreeSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  name: string;
  /** Null until the viewer is latched; then the latched login. */
  owner: string | null;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** The numeric database id, handed out in creation order. */
  dbid: number;
  createdSeq: number;
  objects: Map<string, GitObject>;
  /** Ref name (refs/heads/..., refs/tags/...) to object id. */
  refs: Map<string, string>;
  labels: Map<string, RepoLabel>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** One counter shared by issues and pull requests, from 1, like GitHub's. */
  nextNumber: number;
  /** Deflated object bytes, keyed by oid. Objects are immutable, so a
   * deflated copy stays valid for the life of the process; packing the
   * same repo again (the clone workload re-clones one repo 50 times)
   * then costs no zlib work at all. */
  deflateCache: Map<string, Buffer>;
}

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.dbid}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`Issue:${repo.dbid}:${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`PullRequest:${repo.dbid}:${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repo.dbid}:${issueNumber}:${commentId}`, 'utf8').toString('base64');
}

/** Decode a `Repository:<dbid>` global id, or null when it is not one. */
export function decodeRepoGlobalId(id: string): number | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^Repository:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Decode an `Issue:<dbid>:<number>` global id, or null. */
export function decodeIssueGlobalId(id: string): { dbid: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^Issue:(\d+):(\d+)$/.exec(text);
    return match === null ? null : { dbid: Number(match[1]), number: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Decode a `PullRequest:<dbid>:<number>` global id, or null. */
export function decodePullGlobalId(id: string): { dbid: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^PullRequest:(\d+):(\d+)$/.exec(text);
    return match === null ? null : { dbid: Number(match[1]), number: Number(match[2]) };
  } catch {
    return null;
  }
}

export class Store {
  readonly clock: TrialClock;
  /** The latched viewer login, or null before the first owner-bearing request. */
  viewer: string | null = null;
  /** Repositories by name. Names are unique per trial; the owner check is separate. */
  readonly repos = new Map<string, Repo>();
  /** Request ids, handed out in arrival order (`req-1`, `req-2`, ...). */
  readonly requestIds = new Sequence();
  /** Comment ids, global across repositories, from 1. */
  readonly commentIds = new Sequence();
  /** Ordering stamps, in arrival order. */
  readonly order = new Sequence();
  private nextDbid = 1;

  constructor(clock: TrialClock) {
    this.clock = clock;
  }

  /**
   * Record the owner of the first owner-bearing request. Later owners must
   * match it; repositories created before the latch adopt it.
   */
  latchViewer(owner: string): string {
    if (this.viewer === null) {
      this.viewer = owner;
      for (const repo of this.repos.values()) {
        if (repo.owner === null) repo.owner = owner;
      }
    }
    return this.viewer;
  }

  /** The repository `owner/name`, or null when the owner or the name is unknown. */
  resolveRepo(owner: string, name: string): Repo | null {
    const viewer = this.latchViewer(owner);
    if (owner !== viewer) return null;
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) repo.owner = viewer;
    if (repo.owner !== viewer) return null;
    return repo;
  }

  /** The repository with this numeric database id, or null. */
  repoByDbid(dbid: number): Repo | null {
    for (const repo of this.repos.values()) {
      if (repo.dbid === dbid) return repo;
    }
    return null;
  }

  /** All repositories the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    const viewer = this.viewer;
    return [...this.repos.values()]
      .filter((repo) => repo.owner === null || repo.owner === viewer)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /**
   * Create a repository owned by the token's login. Returns null when a
   * repository of that name already exists.
   */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      owner: this.viewer,
      isPrivate,
      description,
      defaultBranch: 'main',
      dbid: this.nextDbid,
      createdSeq: this.order.take(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      deflateCache: new Map(),
    };
    this.nextDbid += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }
}
