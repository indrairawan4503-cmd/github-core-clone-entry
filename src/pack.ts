// pkt-lines and packfiles: the wire framing of the git smart-HTTP protocol.
//
// A pkt-line is 4 hex digits of total length (itself included) followed by
// the payload. `0000` is a flush, `0001` a delimiter. A packfile is the
// `PACK` header, one zlib-deflated object after another (this forge never
// writes deltas: a client that can read a pack can read a delta-free one),
// and a 20-byte SHA-1 trailer over everything before it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType } from './gitobj.ts';

export const PKT_LINE_MAX = 65520;

/** One pkt-line carrying `payload` (a string is UTF-8 encoded). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush pkt-line (`0000`). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter pkt-line (`0001`). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  /** The payload without the 4-byte length prefix; empty for flush/delim. */
  payload: Buffer;
  /** The whole pkt-line as received, length prefix included. */
  raw: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length prefix,
 * which callers turn into a 400 without taking the server down.
 */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line is truncated');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`pkt-line has a bad length ${JSON.stringify(head)}`);
    }
    packets.push({
      kind: 'data',
      payload: buffer.subarray(offset + 4, offset + length),
      raw: buffer.subarray(offset, offset + length),
    });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one object's pack header: the type/size varint the pack format uses. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in the caller's order. */
/**
 * Write a pack (v2, no deltas) for `objects`. `cache`, when given, holds
 * deflated object bytes keyed by oid: objects are immutable, so a cached
 * copy is always correct, and packing the same repo twice costs no zlib
 * work the second time.
 */
export function writePack(
  objects: readonly Array<{ oid: string; object: GitObject }>,
  cache?: Map<string, Buffer>,
): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const { oid, object } of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    let deflated = cache?.get(oid);
    if (deflated === undefined) {
      deflated = deflateSync(object.data);
      cache?.set(oid, deflated);
    }
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** Read one object's size varint at `start`. */
function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

/** Read an OFS_DELTA base offset at `start`. */
function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] ?? 0;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++] ?? 0;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the next offset. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: Buffer;
  let consumed = 0;
  try {
    const inflated = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    result = inflated.buffer;
    consumed = inflated.engine.bytesWritten;
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  if (consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result, next: offset + consumed };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] ?? 0;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset++] ?? 0) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset++] ?? 0) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA entries. `resolveBase` supplies a base object a
 * thin pack leaves out. Every object's id is recomputed; a mismatch is an
 * error, so a corrupt pack can never be stored as a good clone.
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (trailer !== packChecksum(pack)) throw new Error('pack trailer does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}
