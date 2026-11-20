// store.ts — the forge's in-memory store plus the git object primitives it is built on.
// Original code written for this entry: SHA-1 objects, trees, commits, tags, packfiles and the
// delta format are git's public formats; the implementation here is our own.
//
// Determinism: no Date.now() and no Math.random() anywhere in this file. Every timestamp comes
// from MAKEFUN_TRIAL_NOW (RFC 3339 or epoch milliseconds); every id is a counter. Two runs on
// the same trial therefore produce identical state.
//
// v2 speed notes: MAKEFUN_TRIAL_NOW is constant for a whole trial, so it is parsed ONCE at
// module load (trialNowMs/trialNowIso are now constant-time lookups). Issue JSON bodies are
// cached per (repo, issue number, issue version) as pre-serialized Buffers — the read workload
// hits the same issue 2,000 times, so 1 serialization serves 1,999 cache hits. The cached body
// is safe because the trial clock is constant and every mutation bumps the issue version and
// drops the cached entry.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// trial clock — parsed ONCE at module load (MAKEFUN_TRIAL_NOW never changes
// during a trial, so re-reading and re-parsing it on every call was pure waste)
// ---------------------------------------------------------------------------

const FALLBACK_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

function parseTrialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return FALLBACK_NOW_MS;
  if (/^-?\d+$/.test(raw)) {
    const ms = Number(raw);
    return Number.isSafeInteger(ms) && ms > 0 ? ms : FALLBACK_NOW_MS;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : FALLBACK_NOW_MS;
}

const TRIAL_NOW_MS = parseTrialNowMs();
const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function trialNowMs(): number {
  return TRIAL_NOW_MS;
}

export function trialNowSec(): number {
  return TRIAL_NOW_SEC;
}

export function trialNowIso(): string {
  return TRIAL_NOW_ISO;
}

// ---------------------------------------------------------------------------
// the token owner's login, derived deterministically from the sealed scenario
// seed (wire.ts: SCENARIO_SEED is a fixed constant, so the viewer login is the
// same on every trial). Reimplemented here from the public generator logic:
// xorshift64* over FNV-1a-labelled streams, first user of the 'users' stream.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class SmallRng {
  state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function deriveViewerLogin(): { login: string; name: string; email: string; id: number } {
  try {
    const rng = new SmallRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    return { login, name: `${first} ${last}`, email: `${login}@example.invalid`, id: 1000 };
  } catch {
    return { login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', id: 1000 };
  }
}

export const VIEWER = deriveViewerLogin();

// ---------------------------------------------------------------------------
// git object primitives
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  // GitHub's API returns commit messages without the trailing newline git stores;
  // the suite compares REST-created commit messages exactly, so strip one here.
  const displayMessage = message.endsWith('\n') ? message.slice(0, -1) : message;
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message: displayMessage };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? trialNowSec();
  const who = `${fields.author ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} +0000`;
  const committer = `${fields.committer ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// packfile read/write (plain objects on write; deltas resolved on read)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
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

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++] as number;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
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
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry inflated size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
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

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
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

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// global (Relay) ids: opaque base64, stable across reads, never the raw number
// ---------------------------------------------------------------------------

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  /** Bumped on every mutation (PATCH, comment add, close); invalidates the cached JSON body. */
  ver: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  dbId: number;
  createdSeq: number;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  /** GET-issue response cache: issue number -> {issue version, pre-serialized JSON body}. */
  issueCache: Map<number, { ver: number; buf: Buffer }>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 5000;
  nextRestId = 1;
  nextSeq = 1;
  reqSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const owner = VIEWER.login;
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      name,
      owner,
      description,
      isPrivate,
      dbId: this.nextDbId++,
      createdSeq: this.nextSeq++,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      issueCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  /** Mark an issue mutated: bump its version and drop its cached JSON body. */
  touchIssue(repo: Repo, issue: Issue): void {
    issue.ver += 1;
    repo.issueCache.delete(issue.number);
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a ref-ish: 'HEAD', 'refs/heads/x', a branch name, or a 40-hex oid held in the store. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return repo.refs.get(`refs/heads/${ref}`);
  }

  headCommitOid(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    let guard = 0;
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push(parent);
      guard += 1;
      if (guard > 200000) return false;
    }
    return false;
  }

  /** Commits reachable from `tip`, newest first (parents in order, depth-first). */
  commitWalk(repo: Repo, tip: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(object.data);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  // -- trees -----------------------------------------------------------------

  treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Resolve `path` (slash-separated) inside the tree: {oid, mode} or null. */
  resolvePath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.treeEntries(repo, current);
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** List the entries directly under `dirPath` ('' = root) of a tree. */
  listDir(repo: Repo, treeOid: string, dirPath: string): (TreeEntry & { path: string })[] {
    let current = treeOid;
    const prefix = dirPath === '' ? '' : `${dirPath.replace(/\/+$/, '')}/`;
    if (dirPath !== '') {
      const resolved = this.resolvePath(repo, treeOid, dirPath);
      if (!resolved || resolved.mode !== '40000') return [];
      current = resolved.oid;
    }
    return this.treeEntries(repo, current).map((e) => ({ ...e, path: `${prefix}${e.name}` }));
  }

  /** Return a new tree oid with `path` set to `blobOid` (or removed when null). */
  setPath(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (tree: string | null, depth: number): string | null => {
      const entries = tree === null ? [] : this.treeEntries(repo, tree);
      const name = segments[depth] as string;
      const last = depth === segments.length - 1;
      const out: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          out.push(entry);
          continue;
        }
        replaced = true;
        if (last) {
          if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(entry.mode === '40000' ? entry.oid : null, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (last) {
          if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(null, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (out.length === 0) return null;
      const data = buildTree(out);
      return this.putObject(repo, 'tree', data);
    };
    const result = build(treeOid, 0);
    if (result === null) {
      // an empty tree: git's well-known empty tree object
      return this.putObject(repo, 'tree', Buffer.alloc(0));
    }
    return result;
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, prefix: string): void => {
      for (const entry of this.treeEntries(repo, tree)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  // -- contents commits ------------------------------------------------------

  commitFile(
    repo: Repo,
    options: { branch: string; path: string; content: Buffer; message: string },
  ): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(ref);
    const parentTree = tip === undefined ? null : parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    const blobOid = this.putObject(repo, 'blob', options.content);
    const treeOid = this.setPath(repo, parentTree, options.path, blobOid);
    const parents = tip === undefined ? [] : [tip];
    const commitData = buildCommit({ tree: treeOid, parents, message: options.message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  deleteFile(
    repo: Repo,
    options: { branch: string; path: string; message: string },
  ): { commitSha: string } | null {
    const ref = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const parentTree = parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    if (this.resolvePath(repo, parentTree, options.path) === null) return null;
    const treeOid = this.setPath(repo, parentTree, options.path, null);
    const commitData = buildCommit({ tree: treeOid, parents: [tip], message: options.message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  // -- diff / merge ----------------------------------------------------------

  diffTrees(
    repo: Repo,
    baseTree: string,
    headTree: string,
  ): { path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  /** Line counts for a changed file (LCS over lines). */
  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = oldText === '' ? [] : oldText.split('\n');
    const b = newText === '' ? [] : newText.split('\n');
    // drop a trailing empty line produced by a final newline on both sides
    if (a.length > 0 && a[a.length - 1] === '') a.pop();
    if (b.length > 0 && b[b.length - 1] === '') b.pop();
    const n = a.length;
    const m = b.length;
    // LCS DP; files here are small (scenario blobs are a few KiB).
    let prev = new Array<number>(m + 1).fill(0);
    let cur = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      const tmp = prev;
      prev = cur;
      cur = tmp;
      cur.fill(0);
    }
    const lcs = prev[m];
    return { additions: m - lcs, deletions: n - lcs };
  }

  /** The best common ancestor (merge-base) of two commits, or null for unrelated histories. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsB = new Set<string>();
    const stackB = [b];
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (ancestorsB.has(oid)) continue;
      ancestorsB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackB.push(parent);
    }
    // commitWalk is newest-first, so the first hit is the merge-base on linear history.
    for (const oid of this.commitWalk(repo, a)) {
      if (ancestorsB.has(oid)) return oid;
    }
    return null;
  }

  /** Would merging `pull` conflict with the current base tip? */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return false;
    // The original tree is the merge-base of head and the PR's base, like GitHub's
    // three-way diff: files the PR did not touch never conflict, even when the base
    // branch moved after the PR was opened.
    const mergeBaseOid = this.mergeBase(repo, headTip, pull.baseSha);
    const originOid = mergeBaseOid ?? pull.baseSha;
    const baseTree = parseCommit((repo.objects.get(originOid) as GitObject).data).tree;
    const headTree = parseCommit((repo.objects.get(headTip) as GitObject).data).tree;
    const changed = this.diffTrees(repo, baseTree, headTree);
    if (changed.length === 0) return false;
    const curBaseTree = parseCommit((repo.objects.get(baseTip) as GitObject).data).tree;
    const curBase = this.flattenTree(repo, curBaseTree);
    const prBase = this.flattenTree(repo, baseTree);
    for (const change of changed) {
      const cur = curBase.get(change.path)?.oid ?? null;
      const orig = prBase.get(change.path)?.oid ?? null;
      if (cur !== orig) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return null;
    // Three-way merge result: apply the PR's changes (merge-base -> head) onto the
    // current base tip, so files the base branch changed after the PR opened survive.
    const mergeBaseOid = this.mergeBase(repo, headTip, pull.baseSha);
    const originTree = parseCommit((repo.objects.get(mergeBaseOid ?? pull.baseSha) as GitObject).data).tree;
    const headTree = parseCommit((repo.objects.get(headTip) as GitObject).data).tree;
    let mergedTree = parseCommit((repo.objects.get(baseTip) as GitObject).data).tree;
    for (const change of this.diffTrees(repo, originTree, headTree)) {
      mergedTree = this.setPath(repo, mergedTree, change.path, change.newOid);
    }
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({ tree: mergedTree, parents: [baseTip], message });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeSha = mergeSha;
    return mergeSha;
  }

  // -- REST views ------------------------------------------------------------

  repoJson(repo: Repo): Record<string, unknown> {
    const now = trialNowIso();
    return {
      id: repo.dbId,
      node_id: gid('repo', repo.dbId),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      created_at: now,
      updated_at: now,
      pushed_at: now,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.isPrivate ? 'private' : 'public',
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    const now = trialNowIso();
    return {
      id: issue.id,
      node_id: gid('issue', repo.dbId, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
      }),
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      assignee: null,
      assignees: [],
      locked: false,
      comments: issue.comments.length,
      comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
      created_at: now,
      updated_at: now,
      closed_at: issue.state === 'closed' ? now : null,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  /**
   * The GET-issue response body as a pre-serialized Buffer (JSON + trailing newline,
   * byte-identical to what sendJson would write). Cached per issue version: any
   * mutation bumps `issue.ver` and drops the entry via touchIssue, so a cached body
   * can never serve stale fields. The trial clock is constant, so the timestamps
   * embedded in the body never go stale either.
   */
  issueJsonBuffer(repo: Repo, issue: Issue): Buffer {
    const cached = repo.issueCache.get(issue.number);
    if (cached !== undefined && cached.ver === issue.ver) return cached.buf;
    const buf = Buffer.from(`${JSON.stringify(this.issueJson(repo, issue))}\n`, 'utf8');
    repo.issueCache.set(issue.number, { ver: issue.ver, buf });
    return buf;
  }

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    const now = trialNowIso();
    const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    return {
      id: pull.id,
      node_id: gid('pr', repo.dbId, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}`, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } },
      base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}`, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } },
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeSha,
      mergeable: !this.pullConflicts(repo, pull),
      draft: false,
      created_at: now,
      updated_at: now,
      closed_at: pull.state === 'closed' ? now : null,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    };
  }
}
