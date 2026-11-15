// gitpack.ts — git pack protocol layer for the github-core-clone-01 forge.
//
// Pure bytes in / bytes out: pkt-lines, PACK v2/v3 packfiles (plain objects,
// OFS_DELTA and REF_DELTA), git delta application, and sideband multiplexing.
// Node 22 stdlib only (node:zlib, node:crypto). No deps, no git binary,
// no Date.now()/Math.random() — fully deterministic.
//
// TypeScript with erasable syntax only (Node type-stripping): no enums,
// no parameter properties, no namespaces.

import { createInflate, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// pkt-line framing (https://git-scm.com/docs/protocol-v2#_pkt_line_format)
// ---------------------------------------------------------------------------

export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

// 0002 = response-end (not exported as a constant by the required API, but
// parsePktLines reports it as kind 'response-end').
const PKT_RESPONSE_END_LEN = 2;

/** Maximum pkt-line size including the 4-byte length header. */
const PKT_MAX = 65520;

/**
 * Encode `payload` as one pkt-line: 4 lowercase hex chars (payload length
 * + 4) followed by the payload. Throws if the payload would exceed the
 * 65520-byte packet limit.
 */
export function pktLine(payload: Buffer | string): Buffer {
  const data: Buffer = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX - 4) {
    throw new Error(`pktLine: payload too large (${data.length} bytes, max ${PKT_MAX - 4})`);
  }
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export type PktLineKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface ParsedPktLine {
  kind: PktLineKind;
  data: Buffer;
}

/**
 * Parse pkt-lines from the start of `buf`.
 *
 * Each line starts with a 4-hex-char length: 0000 = flush, 0001 = delim,
 * 0002 = response-end, otherwise a data line of (len - 4) bytes.
 *
 * Parsing stops at the end of the buffer, or after a flush / response-end
 * line (both terminate a pkt-line section); `consumed` is the number of
 * bytes belonging to the lines returned, so the caller can resume parsing
 * a following section at `buf.subarray(consumed)`.
 *
 * Throws on a length < 4, on a non-hex length, or on a length that runs
 * beyond the end of the buffer.
 */
export function parsePktLines(buf: Buffer): { lines: ParsedPktLine[]; consumed: number } {
  const lines: ParsedPktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`parsePktLines: truncated length header at offset ${offset}`);
    }
    const lenText = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) {
      throw new Error(`parsePktLines: invalid pkt-line length ${JSON.stringify(lenText)} at offset ${offset}`);
    }
    const len = parseInt(lenText, 16);
    if (len < 4) {
      // 0, 1, 2 and 3 are the special markers; anything else < 4 is invalid.
      if (len === 0) {
        lines.push({ kind: 'flush', data: Buffer.alloc(0) });
        offset += 4;
        break;
      }
      if (len === 1) {
        lines.push({ kind: 'delim', data: Buffer.alloc(0) });
        offset += 4;
        continue;
      }
      if (len === PKT_RESPONSE_END_LEN) {
        lines.push({ kind: 'response-end', data: Buffer.alloc(0) });
        offset += 4;
        break;
      }
      throw new Error(`parsePktLines: invalid pkt-line length ${len} at offset ${offset}`);
    }
    if (offset + len > buf.length) {
      throw new Error(
        `parsePktLines: pkt-line length ${len} at offset ${offset} exceeds buffer (${buf.length} bytes)`,
      );
    }
    lines.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { lines, consumed: offset };
}

// ---------------------------------------------------------------------------
// Packfiles (PACK v2/v3)
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface PackObjectInput {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

export interface PackObject {
  type: string;
  data: Buffer;
}

const TYPE_CODES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TYPES: Record<number, string> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

/** Git object id: SHA-1 of "<type> <size>\0" + raw content. */
function objectId(type: string, data: Buffer): string {
  return createHash('sha1')
    .update(`${type} ${data.length}\0`, 'utf8')
    .update(data)
    .digest('hex');
}

/** Encode a pack entry header: varint type/size (see spec). */
function encodeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (remaining & 0x0f) | (typeCode << 4);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let b = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Build a PACK v2 packfile of plain (non-delta) objects, in the given
 * order. Each entry is a type/size varint header followed by the zlib
 * stream of the object data. The 20-byte trailer is the SHA-1 of all
 * preceding bytes. No stray bytes.
 */
export function buildPack(objects: PackObjectInput[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    if (typeCode === undefined) {
      throw new Error(`buildPack: unknown object type ${JSON.stringify(obj.type)}`);
    }
    parts.push(encodeEntryHeader(typeCode, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a git delta varint (7 bits per byte, LSB first, MSB continuation). */
function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) {
      throw new Error('applyDelta/parsePack: truncated varint');
    }
    const b = buf[i];
    i += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
    if (shift > 56) throw new Error('applyDelta/parsePack: varint too large');
  }
  return { value, next: i };
}

/**
 * Inflate the zlib stream starting at `start` in `buf`.
 *
 * Uses a streaming Inflate and reads `bytesWritten` — the native side
 * consumes exactly the stream's bytes and stops, so `bytesWritten` is
 * the stream end even when trailing bytes follow. This replaces the
 * earlier probe+binary-search over `inflateSync`, whose throws on
 * truncated slices cost ~46us each (vs ~15us for a success) and
 * dominated pack-parse time on the push workload.
 *
 * `limit` is an exclusive upper bound on the stream end (the trailer
 * start for the last entry). Rejects when the stream is truncated or
 * the inflated length differs from `expectedSize`.
 */
function inflateAt(buf: Buffer, start: number, expectedSize: number, limit: number): Promise<{ data: Buffer; end: number }> {
  return new Promise<{ data: Buffer; end: number }>((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        inf.destroy();
      } catch {
        // Already gone.
      }
      reject(err);
    };
    inf.on('data', (chunk: Buffer) => chunks.push(chunk));
    inf.on('error', (err: Error) => fail(err));
    inf.on('close', () => {
      if (!settled) fail(new Error(`parsePack: zlib stream at offset ${start} closed without completing`));
    });
    inf.on('end', () => {
      if (settled) return;
      settled = true;
      const data = Buffer.concat(chunks);
      if (data.length !== expectedSize) {
        reject(new Error(`parsePack: inflated ${data.length} bytes at offset ${start}, expected ${expectedSize}`));
        return;
      }
      resolve({ data, end: start + inf.bytesWritten });
    });
    inf.end(buf.subarray(start, limit));
  });
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  // For plain objects: inflated data. For deltas: inflated delta payload.
  data: Buffer;
  // OFS_DELTA: base entry offset. REF_DELTA: base oid (hex).
  baseOffset: number | null;
  baseOid: string | null;
}

/**
 * Parse a PACK v2/v3 packfile into a Map from oid to { type, data }.
 *
 * Handles OFS_DELTA (base = an earlier entry in the pack) and REF_DELTA
 * (base oid; taken from entries already in the pack, or via `resolveBase`
 * for thin packs). Deltas are resolved lazily in a second pass, so a
 * REF_DELTA may reference a base defined later in the pack, and delta
 * chains are followed. Verifies the 20-byte trailer SHA-1.
 * Async: each entry's zlib stream is inflated with a streaming Inflate
 * (see inflateAt). Rejects Error on malformed input.
 */
export async function parsePack(
  buf: Buffer,
  resolveBase?: (oid: string) => { type: string; data: Buffer } | undefined,
): Map<string, PackObject> {
  if (buf.length < 12 + 20) {
    throw new Error(`parsePack: pack too short (${buf.length} bytes)`);
  }
  if (buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('parsePack: bad magic (expected "PACK")');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`parsePack: unsupported PACK version ${version} (expected 2 or 3)`);
  }
  const count = buf.readUInt32BE(8);

  // Verify the trailer SHA-1 before parsing entries.
  const trailerStart = buf.length - 20;
  const expectedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest();
  if (!expectedTrailer.equals(buf.subarray(trailerStart))) {
    throw new Error('parsePack: trailer SHA-1 mismatch');
  }

  // First pass: parse every entry header + zlib stream, keeping delta
  // payloads unresolved.
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, number>(); // entry offset -> index in entries
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    if (offset >= trailerStart) {
      throw new Error(`parsePack: entry ${n} starts beyond the pack body (offset ${offset})`);
    }
    const entryOffset = offset;
    let b = buf[offset];
    offset += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (offset >= trailerStart) throw new Error('parsePack: truncated entry header');
      b = buf[offset];
      offset += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4 && typeCode !== OBJ_OFS_DELTA && typeCode !== OBJ_REF_DELTA) {
      throw new Error(`parsePack: unknown object type code ${typeCode} at entry offset ${entryOffset}`);
    }

    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (typeCode === OBJ_OFS_DELTA) {
      // Git OFS_DELTA base-offset varint: byte0 = value & 0x7f; while the
      // next byte is present: value = ((value + 1) << 7) | (byte & 0x7f).
      if (offset >= trailerStart) throw new Error('parsePack: truncated OFS_DELTA base offset');
      b = buf[offset];
      offset += 1;
      let base = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (offset >= trailerStart) throw new Error('parsePack: truncated OFS_DELTA base offset');
        b = buf[offset];
        offset += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - base;
      if (baseOffset < 12 || baseOffset >= entryOffset) {
        throw new Error(`parsePack: OFS_DELTA base offset ${base} at entry ${entryOffset} does not point at an earlier entry`);
      }
    } else if (typeCode === OBJ_REF_DELTA) {
      if (offset + 20 > trailerStart) throw new Error('parsePack: truncated REF_DELTA base oid');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    const inflated = await inflateAt(buf, offset, size, trailerStart);
    offset = inflated.end;
    byOffset.set(entryOffset, entries.length);
    entries.push({ offset: entryOffset, typeCode, size, data: inflated.data, baseOffset, baseOid });
  }
  if (offset !== trailerStart) {
    throw new Error(`parsePack: ${offset - trailerStart > 0 ? 'overshot' : 'trailing bytes before trailer'} (entries end at ${offset}, trailer at ${trailerStart})`);
  }

  // Second pass: resolve objects, lazily so REF_DELTA forward references
  // and delta chains work.
  const resolved = new Map<string, PackObject>();
  const resolvedByOffset = new Map<number, PackObject>();
  const pending = new Set<number>();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.typeCode === OBJ_OFS_DELTA || e.typeCode === OBJ_REF_DELTA) {
      pending.add(i);
    } else {
      const type = CODE_TYPES[e.typeCode];
      const obj: PackObject = { type, data: e.data };
      resolved.set(objectId(type, e.data), obj);
      resolvedByOffset.set(e.offset, obj);
    }
  }

  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const i of [...pending]) {
      const e = entries[i];
      let base: PackObject | undefined;
      if (e.typeCode === OBJ_OFS_DELTA) {
        const baseIndex = byOffset.get(e.baseOffset as number);
        if (baseIndex === undefined) {
          throw new Error(`parsePack: OFS_DELTA at offset ${e.offset} references unknown entry offset ${e.baseOffset}`);
        }
        base = resolvedByOffset.get(entries[baseIndex].offset);
      } else {
        // REF_DELTA: base may be inside this pack (any entry, including
        // one resolved from a delta) or outside it (thin pack).
        const baseOid = e.baseOid as string;
        base = resolved.get(baseOid);
        if (base === undefined && resolveBase !== undefined) {
          base = resolveBase(baseOid);
        }
      }
      if (base === undefined) continue; // maybe resolvable in a later round
      const data = applyDelta(base.data, e.data);
      const obj: PackObject = { type: base.type, data };
      resolved.set(objectId(base.type, data), obj);
      resolvedByOffset.set(e.offset, obj);
      pending.delete(i);
      progress = true;
    }
  }
  if (pending.size > 0) {
    const first = entries[[...pending][0]];
    if (first.typeCode === OBJ_REF_DELTA) {
      throw new Error(`parsePack: REF_DELTA at offset ${first.offset} has unresolvable base oid ${first.baseOid}`);
    }
    throw new Error(`parsePack: OFS_DELTA at offset ${first.offset} has unresolvable base (delta chain could not be resolved)`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

/**
 * Apply a git delta to `base`.
 *
 * Delta format: source-size varint, target-size varint, then opcodes:
 * copy 0x80 (offset/size bitfields, size 0 => 0x10000), insert 0x01-0x7F
 * (that many literal bytes follow), 0x00 invalid. The result must be
 * exactly the target size, and the base length must equal the source size.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) {
    throw new Error(`applyDelta: source size ${source.value} does not match base length ${base.length}`);
  }
  const target = readVarint(delta, source.next);
  const targetSize = target.value;
  let pos = target.next;
  const chunks: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      // Copy from base: bits 0-3 = offset bytes present (little-endian),
      // bits 4-6 = size bytes present.
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('applyDelta: truncated copy opcode (offset)');
          copyOffset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('applyDelta: truncated copy opcode (size)');
          copySize |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) {
        throw new Error(`applyDelta: copy out of range (offset ${copyOffset}, size ${copySize}, base length ${base.length})`);
      }
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (op === 0) {
      throw new Error('applyDelta: invalid opcode 0x00');
    } else {
      // Insert: op literal bytes follow.
      if (pos + op > delta.length) {
        throw new Error('applyDelta: truncated insert opcode');
      }
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    }
  }
  if (outLen !== targetSize) {
    throw new Error(`applyDelta: result length ${outLen} does not match target size ${targetSize}`);
  }
  return Buffer.concat(chunks, outLen);
}

// ---------------------------------------------------------------------------
// Sideband (sideband-64k)
// ---------------------------------------------------------------------------

/** Max data bytes per sideband pkt-line: 65520 - 4 (header) - 1 (band). */
const SIDEBAND_CHUNK = 65515;

/**
 * Wrap `data` for sideband `band` (1 = pack data, 2 = progress, 3 = error)
 * into pkt-lines, splitting into chunks of at most 65515 data bytes each.
 * Each packet is pktLine(band byte + chunk).
 */
export function sidebandWrap(band: 1 | 2 | 3, data: Buffer): Buffer {
  if (band !== 1 && band !== 2 && band !== 3) {
    throw new Error(`sidebandWrap: invalid band ${band} (expected 1, 2 or 3)`);
  }
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

/**
 * Demultiplex a sideband stream: parse its pkt-lines and collect bytes by
 * band. Band 1 is returned as a Buffer; bands 2 and 3 are decoded as
 * UTF-8 strings. Flush lines are ignored.
 */
export function sidebandDemux(buf: Buffer): { band1: Buffer; band2: string; band3: string } {
  const band1Parts: Buffer[] = [];
  const band2Parts: Buffer[] = [];
  const band3Parts: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`sidebandDemux: truncated length header at offset ${offset}`);
    }
    const lenText = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) {
      throw new Error(`sidebandDemux: invalid pkt-line length ${JSON.stringify(lenText)} at offset ${offset}`);
    }
    const len = parseInt(lenText, 16);
    if (len === 0) {
      offset += 4; // flush: ignored
      continue;
    }
    if (len === 1 || len === 2) {
      offset += 4; // delim / response-end: ignored
      continue;
    }
    if (len < 4) {
      throw new Error(`sidebandDemux: invalid pkt-line length ${len} at offset ${offset}`);
    }
    if (offset + len > buf.length) {
      throw new Error(`sidebandDemux: pkt-line length ${len} at offset ${offset} exceeds buffer (${buf.length} bytes)`);
    }
    const payload = buf.subarray(offset + 4, offset + len);
    if (payload.length < 1) {
      throw new Error('sidebandDemux: sideband packet with no band byte');
    }
    const band = payload[0];
    const rest = payload.subarray(1);
    if (band === 1) band1Parts.push(rest);
    else if (band === 2) band2Parts.push(rest);
    else if (band === 3) band3Parts.push(rest);
    else throw new Error(`sidebandDemux: unknown sideband ${band}`);
    offset += len;
  }
  return {
    band1: Buffer.concat(band1Parts),
    band2: Buffer.concat(band2Parts).toString('utf8'),
    band3: Buffer.concat(band3Parts).toString('utf8'),
  };
}
