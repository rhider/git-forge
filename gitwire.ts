// Git smart-HTTP wire: pkt-lines, pack v2 read/write, upload-pack (v2 + v0 fallback) and
// receive-pack (v0). Written against the sealed suite's git-client.ts behaviour, verbatim:
//  - v2 advertisement is GET info/refs with `Git-Protocol: version=2` → `# service=` preamble,
//    `version 2` + capability lines, flush.
//  - v2 fetch response sections in order: acknowledgments / shallow-info / wanted-refs / packfile,
//    each ended by delim, the response by flush; packfile has >= 1 sideband packet.
//  - v0 fetch response: NAK + shallow/unshallow text lines + sideband pack + flush.
//  - push report is pkt-lined `unpack ok` + ok/ng lines inside sideband band 1 + flush.
//  - Fast-forward only; a non-FF refusal reason is exactly `non-fast-forward`, unpackOk stays true.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  Store,
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  parseTagTarget,
  type GitObject,
  type ObjectType,
  type Repo,
} from './store.ts';

const AGENT = 'makefun-git-forge/1.0';
const V2_CAPS = ['agent=' + AGENT, 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
const V0_UPLOAD_CAPS =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=' +
  AGENT +
  ' symref=HEAD:refs/heads/main object-format=sha1';
const V0_RECEIVE_CAPS =
  'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT + ' symref=HEAD:refs/heads/main';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse pkt-lines until the first flush (inclusive); the rest of the buffer is returned raw
 *  (receive-pack carries its pack bytes there). Throws on a malformed length. */
export function decodeUntilFlush(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const { packets, consumed } = decodePackets(buf, true);
  return { packets, rest: buf.subarray(consumed) };
}

/** Parse a whole buffer as pkt-lines (no raw tail allowed). */
export function decodeAll(buf: Buffer): Packet[] {
  const { packets, consumed } = decodePackets(buf, true);
  if (consumed !== buf.length) throw new Error('unexpected bytes after pkt-line flush');
  return packets;
}

/** Parse every pkt-line in a buffer (multiple flushes allowed, e.g. a v0 fetch's two sections). */
export function decodePackets(buf: Buffer, stopAtFirstFlush = false): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`malformed pkt-line header ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      if (stopAtFirstFlush) return { packets, consumed: off };
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return { packets, consumed: off };
}

export function encodePktLines(lines: Array<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else if (line === 'response-end') parts.push(Buffer.from('0002'));
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Frame data into sideband packets (band byte + chunk), each pkt-line <= 65520 bytes. */
export function sidebandFrame(band: 1 | 2 | 3, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65520 - 5;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), Buffer.alloc(0)])));
    return Buffer.concat(parts);
  }
  for (let off = 0; off < data.length; off += maxChunk) {
    const chunk = data.subarray(off, Math.min(off + maxChunk, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// pack v2
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writeVarintHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Plain-object pack v2 (no deltas): header + deflated objects + SHA-1 trailer.
 *  Deflated bytes are cached by oid: an object's bytes are immutable (content-addressed),
 *  so the same object is never deflated twice. This matters for the clone workload, where
 *  50 concurrent clones fetch the same tip objects. */
const deflatedCache = new Map<string, Buffer>();

export function writePack(objects: Array<{ type: ObjectType; oid: string; data: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(writeVarintHeader(TYPE_CODE[obj.type], obj.data.length));
    let deflated = deflatedCache.get(obj.oid);
    if (!deflated) {
      deflated = deflateSync(obj.data, { level: 1 });
      if (deflatedCache.size > 20000) deflatedCache.clear();
      deflatedCache.set(obj.oid, deflated);
    }
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  // Trailer: SHA-1 of the pack bytes themselves (not a git object hash).
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `off`; bisection finds the exact stream end
 *  (inflateSync ignores trailing bytes, so the minimal succeeding prefix is the true end). */
function inflateOne(buf: Buffer, off: number): { data: Buffer; consumed: number } {
  let lo = off + 1;
  let hi = buf.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('deflate stream does not terminate');
  return { data: inflateSync(buf.subarray(off, found)), consumed: found - off };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off];
      off += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[off++];
      if (op & 0x02) offset |= delta[off++] << 8;
      if (op & 0x04) offset |= delta[off++] << 16;
      if (op & 0x08) offset |= delta[off++] << 24;
      if (op & 0x10) size = delta[off++];
      if (op & 0x20) size |= delta[off++] << 8;
      if (op & 0x40) size |= delta[off++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (total !== tgtSize || result.length !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

export function readPack(buf: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!actual.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let off = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = buf[off];
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjectType;
    let data: Buffer;
    if (typeCode === 6) {
      // OFS_DELTA: offset varint, then deflated delta against the object at start - offset.
      byte = buf[off];
      off += 1;
      let deltaOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[off];
        off += 1;
        deltaOffset = ((deltaOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseOid = byOffset.get(start - deltaOffset);
      if (!baseOid) throw new Error('ofs-delta base not found');
      const base = objects.get(baseOid);
      if (!base) throw new Error('ofs-delta base not found');
      const inflated = inflateOne(buf, off);
      off += inflated.consumed;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base oid, then deflated delta.
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const inflated = inflateOne(buf, off);
      off += inflated.consumed;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      deltaCount += 1;
    } else {
      type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateOne(buf, off);
      off += inflated.consumed;
      data = inflated.data;
      if (data.length !== size) throw new Error('object size mismatch in pack');
    }
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    byOffset.set(start, oid);
  }
  return { objects, deltaCount };
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  objects: Map<string, GitObject>;
  sentCommits: Set<string>;
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}

export function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  const extraTagOids: string[] = [];
  const commitWants: string[] = [];
  for (const want of wants) {
    const obj = store.getObject(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraTagOids.push(want);
      const target = parseTagTarget(obj.data);
      if (target) commitWants.push(target);
    } else if (obj.type === 'commit') {
      commitWants.push(want);
    } else {
      extraTagOids.push(want);
    }
  }
  const haveCommits = store.heldClosure(haves, shallowBoundaries);
  const haveObjects = store.objectClosure(haveCommits);
  const sentCommits =
    depth != null ? store.commitsWithinDepth(commitWants, depth) : store.commitClosure(commitWants);
  // Never re-send what the client already holds.
  for (const oid of haveCommits) sentCommits.delete(oid);
  const sentObjects = store.objectClosure(sentCommits, extraTagOids);
  for (const oid of haveObjects) sentObjects.delete(oid);
  const objects = new Map<string, GitObject>();
  for (const oid of sentObjects) {
    const obj = store.getObject(oid);
    if (obj) objects.set(oid, obj);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth != null) {
    // New boundary: a sent commit whose parents are neither sent nor held.
    for (const oid of sentCommits) {
      const parents = store.commitParents(oid);
      if (parents.length === 0) continue;
      const connected = parents.every((p) => sentCommits.has(p) || haveCommits.has(p));
      if (!connected) shallow.push(oid);
    }
    // Moved boundary: an old shallow commit whose parents are now all available.
    for (const boundary of shallowBoundaries) {
      const parents = store.commitParents(boundary);
      const available = (oid: string): boolean => sentCommits.has(oid) || haveCommits.has(oid);
      if (available(boundary) && parents.every(available)) unshallow.push(boundary);
    }
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of wants) {
    for (const [ref, oid] of repo.refs) {
      if (oid === want) wantedRefs.push({ oid, ref });
    }
  }
  return { objects, sentCommits, shallow, unshallow, wantedRefs };
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function refLines(store: Store, repo: Repo, caps: string): string[] {
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (entries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  let first = true;
  const pushLine = (oid: string, name: string): void => {
    lines.push(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`);
    first = false;
  };
  if (headTip) pushLine(headTip, 'HEAD');
  else pushLine(ZERO_OID, 'HEAD');
  for (const [name, oid] of entries) {
    pushLine(oid, name);
    const obj = store.getObject(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) lines.push(`${target} ${name}^{}\n`);
    }
  }
  return lines;
}

export function uploadPackAdvertisement(store: Store, repo: Repo, version2: boolean): { contentType: string; body: Buffer } {
  if (version2) {
    const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n'];
    for (const cap of V2_CAPS) lines.push(`${cap}\n`);
    lines.push('flush');
    return { contentType: 'application/x-git-upload-pack-advertisement', body: encodePktLines(lines) };
  }
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
  for (const line of refLines(store, repo, V0_UPLOAD_CAPS)) lines.push(line);
  lines.push('flush');
  return { contentType: 'application/x-git-upload-pack-advertisement', body: encodePktLines(lines) };
}

export function receivePackAdvertisement(store: Store, repo: Repo): { contentType: string; body: Buffer } {
  const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
  for (const line of refLines(store, repo, V0_RECEIVE_CAPS)) lines.push(line);
  lines.push('flush');
  return { contentType: 'application/x-git-receive-pack-advertisement', body: encodePktLines(lines) };
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

export function handleLsRefs(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets } = decodeUntilFlush(body);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  // HEAD is filtered by ref-prefix like any other ref: it only appears when no prefix is
  // given (or a prefix that matches the literal name "HEAD").
  if (symrefs && keep('HEAD')) {
    if (headTip) out.push(`${headTip} HEAD symref-target:${headRef}\n`);
    else if (unborn) out.push(`unborn HEAD symref-target:${headRef}\n`);
  }
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of entries) {
    if (!keep(name)) continue;
    let attrs = '';
    if (peel) {
      const obj = store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) attrs = ` peeled:${target}`;
      }
    }
    out.push(`${oid} ${name}${attrs}\n`);
  }
  if (entries.length === 0 && unborn && !symrefs && keep('HEAD')) {
    out.push(`unborn HEAD symref-target:${headRef}\n`);
  }
  const parts = out.map((line) => pktLine(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchLines(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: parsed, not needed.
  }
  return args;
}

export function handleFetchV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets } = decodeUntilFlush(body);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const args = parseFetchLines(lines);
  const plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack([...plan.objects.entries()].map(([oid, obj]) => ({ type: obj.type, oid, data: obj.data })));
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(DELIM);
  parts.push(pktLine('shallow-info\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(DELIM);
  parts.push(pktLine('wanted-refs\n'));
  for (const entry of plan.wantedRefs) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
  parts.push(DELIM);
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandFrame(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  // v0 fetch has two pkt-line sections (wants, then haves + done), so parse every packet.
  const { packets } = decodePackets(body);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const args = parseFetchLines(lines);
  const plan = planFetch(store, repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack([...plan.objects.entries()].map(([oid, obj]) => ({ type: obj.type, oid, data: obj.data })));
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  if (args.depth != null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(sidebandFrame(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack (v0)
// -------------------------------------------------------------------------------------------

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodeUntilFlush(body);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  // Unpack first: store every pushed object, then validate refs one by one.
  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const read = readPack(rest);
      for (const [oid, obj] of read.objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  const report: string[] = [];
  report.push(unpackOk ? 'unpack ok\n' : 'unpack error\n');
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
      report.push(`ng ${cmd.ref} invalid command\n`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) report.push(`ng ${cmd.ref} remote ref does not exist\n`);
      else if (current !== cmd.oldOid) report.push(`ng ${cmd.ref} non-fast-forward\n`);
      else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    const newObj = store.getObject(cmd.newOid);
    if (!newObj) {
      report.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current) report.push(`ng ${cmd.ref} already exists\n`);
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    // Update: old must match the current tip and new must descend from old.
    if (!current) {
      report.push(`ng ${cmd.ref} remote ref does not exist\n`);
      continue;
    }
    if (current !== cmd.oldOid) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    let target = cmd.newOid;
    if (newObj.type === 'tag') {
      const peeled = parseTagTarget(newObj.data);
      if (!peeled) {
        report.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      target = peeled;
    }
    if (newObj.type !== 'commit' && newObj.type !== 'tag') {
      report.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (!store.isAncestor(cmd.oldOid, target)) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push(`ok ${cmd.ref}\n`);
  }
  const reportBytes = encodePktLines(report);
  return Buffer.concat([sidebandFrame(1, reportBytes), FLUSH]);
}
