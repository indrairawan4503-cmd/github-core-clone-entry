// Git smart HTTP: info/refs advertisements (protocol v2 for upload-pack,
// v0 for receive-pack), v2 ls-refs and fetch, and v0 receive-pack pushes.
//
// The framing is pkt-lines throughout. Fetch answers come in sections
// (acknowledgments, shallow-info, packfile) with the pack inside sideband
// band 1; push answers are report-status lines inside sideband band 1.

import { applyPush, planFetch, type PushCommand } from './gitops.ts';
import { isObjectId, parseTag, ZERO_OID } from './gitobj.ts';
import {
  decodePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './pack.ts';
import type { Repo, Store } from './store.ts';

export interface GitResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

const V0_CAPS =
  'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** The refs of a repository, sorted by name. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, oid]) => ({ name, oid }));
}

/** The commit an annotated tag peels to, following tag chains. */
function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return object?.type === 'commit' ? current : null;
    current = parseTag(object.data).object;
  }
  return null;
}

// ---------------------------------------------------------------- advertisements

function advertisementV2(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${V0_CAPS}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${V0_CAPS}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelTag(repo, ref.oid);
          if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
        }
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string,
): GitResponse {
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, body: Buffer.from('Not Found', 'utf8'), contentType: 'text/plain' };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, body: advertisementV2(repo), contentType: UPLOAD_AD };
    }
    return { status: 200, body: advertisementV0(repo, 'git-upload-pack'), contentType: UPLOAD_AD };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, body: advertisementV0(repo, 'git-receive-pack'), contentType: RECEIVE_AD };
  }
  return { status: 400, body: Buffer.from('unknown service', 'utf8'), contentType: 'text/plain' };
}

// ---------------------------------------------------------------- pkt-line stream reading

interface StreamRead {
  /** Data packets in order, up to and including the first flush (if any). */
  packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }>;
  /** Offset just past the flush pkt-line, where raw bytes (a pack) may follow. */
  restOffset: number;
}

/** Read pkt-lines until the first flush; anything after it is returned as an offset. */
function readUntilFlush(buffer: Buffer): StreamRead {
  const packets: StreamRead['packets'] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line is truncated');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, restOffset: offset + 4 };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`pkt-line has a bad length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, restOffset: offset };
}

// ---------------------------------------------------------------- upload-pack

/** POST /{owner}/{repo}.git/git-upload-pack (v2 ls-refs or fetch). */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, body: Buffer.from('Not Found', 'utf8'), contentType: 'text/plain' };
  }
  let packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }>;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, body: Buffer.from('malformed pkt-line stream', 'utf8'), contentType: 'text/plain' };
  }
  const lines = packets.map((packet) =>
    packet.kind === 'delim' ? 'delim' : packet.kind === 'flush' ? 'flush' : packet.payload.toString('utf8'),
  );
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs\n') return lsRefs(repo, lines.slice(1));
  if (command === 'command=fetch\n') return fetchPack(repo, lines.slice(1));
  return { status: 400, body: Buffer.from('unknown upload-pack command', 'utf8'), contentType: 'text/plain' };
}

function lsRefs(repo: Repo, lines: string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line === 'delim') {
      seenDelim = true;
      continue;
    }
    if (!seenDelim) continue; // command arguments before the delimiter (agent, object-format)
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid === undefined) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else if (keep('HEAD')) {
    const extra = symrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pktLine(`${headOid} HEAD${extra}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return { status: 200, body: Buffer.concat(parts), contentType: UPLOAD_RESULT };
}

function fetchPack(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let seenDelim = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line === 'delim') {
      seenDelim = true;
      continue;
    }
    if (!seenDelim) continue;
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] ?? '';
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
  }
  const plan = planFetch(repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktDelim());
  if (depth !== undefined && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.objects, repo.deflateCache);
    // Sideband band 1, chunked so no pkt-line exceeds the 65520-byte cap.
    const CHUNK = 65000;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(pktFlush());
  return { status: 200, body: Buffer.concat(parts), contentType: UPLOAD_RESULT };
}

// ---------------------------------------------------------------- receive-pack

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) {
    return { status: 404, body: Buffer.from('Not Found', 'utf8'), contentType: 'text/plain' };
  }
  let read: StreamRead;
  try {
    read = readUntilFlush(body);
  } catch {
    return { status: 400, body: Buffer.from('malformed pkt-line stream', 'utf8'), contentType: 'text/plain' };
  }
  const commands: PushCommand[] = [];
  for (const packet of read.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul < 0 ? text : text.slice(0, nul);
    const parts = commandText.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(read.restOffset);
  const hasPack = packBytes.length > 0;
  if (hasPack) {
    try {
      const objects = readPack(packBytes, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack error';
    }
  }
  let outcomes: Array<{ ref: string; ok: boolean; reason: string }>;
  if (!unpackOk) {
    outcomes = commands.map((command) => ({ ref: command.ref, ok: false, reason: unpackDetail }));
  } else {
    outcomes = applyPush(repo, commands);
  }
  const reportLines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const outcome of outcomes) {
    reportLines.push(
      pktLine(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`),
    );
  }
  const report = Buffer.concat(reportLines);
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return { status: 200, body: Buffer.concat(parts), contentType: RECEIVE_RESULT };
}
