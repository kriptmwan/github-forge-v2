// git.ts — git smart HTTP: info/refs advertisements (v0 + v2), ls-refs, fetch (v2 + v0
// fallback) and receive-pack (v0). Original implementation for this entry, written against
// git's public wire formats. Objects are stored verbatim: a fetch re-sends the exact bytes
// a push stored, so hashes always recompute.
//
// v2 speed notes (conformance behavior unchanged):
// - The v2 advertisement is a constant: one prebuilt Buffer is returned for every request.
// - The v0 advertisement and ls-refs answers are cached per repo, keyed by a fingerprint of
//   the ref set (head oid + every ref name/oid). Refs change only through paths this server
//   controls, and the fingerprint recomputes from the live ref map on every request, so a
//   stale entry is impossible: any ref move changes the fingerprint and misses the cache.
// - Fetch responses are cached whole, keyed by the canonical fetch arguments (protocol,
//   repo, sorted wants/haves/shallow boundaries, depth, deepen-relative, done). Objects are
//   immutable and wants are content-addressed OIDs, so a cached pack for a key stays valid
//   forever — but only when every want/have/shallow OID named in the key already exists in
//   the store at cache time (an OID that does not exist yet could be pushed later and change
//   the answer, so such fetches are never cached). The 50 concurrent shallow clones of the
//   clone workload send byte-identical fetch requests: 1 pack build + 49 cache hits.
// - Caches are dropped for a repo when it is deleted (invalidateRepoCaches).

import {
  collectReachable,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const PKT_MAX_PAYLOAD = 65520 - 4;

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode pkt-lines from `buf` until a flush/end or the buffer runs out. Returns packets + bytes consumed. */
function decodePktLines(buf: Buffer): { packets: DecodedPacket[]; consumed: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length < 4 || length > 65520 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

function pktLinesText(packets: readonly DecodedPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Peel an annotated tag (recursively) to its commit. Returns null when it does not peel. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// ---------------------------------------------------------------------------
// response caches (see the header note for the validity argument of each)
// ---------------------------------------------------------------------------

/** A fingerprint of the live ref set: head oid + every ref name/oid, sorted. */
function refFingerprint(repo: Repo): string {
  const head = headOid(repo) ?? '-';
  const parts = [head];
  for (const ref of sortedRefs(repo)) parts.push(`${ref.name}=${ref.oid}`);
  return parts.join('|');
}

const V2_AD = Buffer.concat([
  pkt('version 2\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  pkt('agent=github-forge/1.0\n'),
  FLUSH,
]);

interface Fingerprinted {
  fp: string;
  buf: Buffer;
}

/** v0 advertisement cache: `${service}|${owner}/${repo}` -> {fingerprint, body}. */
const v0AdCache = new Map<string, Fingerprinted>();
/** ls-refs cache: `${owner}/${repo}|${args joined}` -> {fingerprint, body}. */
const lsRefsCache = new Map<string, Fingerprinted>();
/** Whole fetch responses: canonical fetch key -> body. FIFO-capped at 128 entries. */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(
  protocol: 'v2' | 'v0',
  owner: string,
  repoName: string,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | undefined,
  deepenRelative: boolean,
  done: boolean,
): string {
  const sortJoin = (list: readonly string[]): string => [...list].sort().join(',');
  return [
    `fetch:${protocol}:${owner}/${repoName}`,
    `w=${sortJoin(wants)}`,
    `h=${sortJoin(haves)}`,
    `s=${sortJoin(shallowIn)}`,
    `d=${depth === undefined ? '-' : depth}`,
    `dr=${deepenRelative ? 1 : 0}`,
    `done=${done ? 1 : 0}`,
  ].join('|');
}

function fetchCacheStore(key: string, body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX && !fetchCache.has(key)) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, body);
}

/** Drop every cached git response belonging to one repo (called when the repo is deleted). */
export function invalidateRepoCaches(owner: string, name: string): void {
  const prefix = `${owner}/${name}`;
  for (const key of [...v0AdCache.keys()]) {
    if (key.endsWith(`|${prefix}`)) v0AdCache.delete(key);
  }
  for (const key of [...lsRefsCache.keys()]) {
    if (key.startsWith(`${prefix}|`)) lsRefsCache.delete(key);
  }
  for (const key of [...fetchCache.keys()]) {
    if (key.includes(`:${prefix}|`)) fetchCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${defaultRef} side-band-64k thin-pack ofs-delta shallow agent=github-forge/1.0`
      : `symref=HEAD:${defaultRef} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-forge/1.0`;
  parts.push(pkt(`# service=${service}\n`));
  parts.push(FLUSH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${head ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) parts.push(pkt(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v0AdvertisementCached(
  owner: string,
  repoName: string,
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const key = `${service}|${owner}/${repoName}`;
  const fp = refFingerprint(repo);
  const cached = v0AdCache.get(key);
  if (cached !== undefined && cached.fp === fp) return cached.buf;
  const buf = v0Advertisement(repo, service);
  v0AdCache.set(key, { fp, buf });
  return buf;
}

function v2Advertisement(): Buffer {
  return V2_AD;
}

// ---------------------------------------------------------------------------
// fetch object selection
// ---------------------------------------------------------------------------

/** The tree closure (trees + blobs) under `treeOid`. */
function treeClosure(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const object = repo.objects.get(treeOid);
  if (!object) return;
  out.set(treeOid, object);
  if (object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '160000') continue;
    const child = repo.objects.get(entry.oid);
    if (!child) continue;
    if (child.type === 'tree') treeClosure(repo, entry.oid, out);
    else out.set(entry.oid, child);
  }
}

/**
 * Select the objects a fetch sends.
 * - no depth: everything reachable from wants, minus everything reachable from haves.
 * - depth d: commits within d-1 edges of wants (tags unwrap to their commit at the same
 *   generation), their tree closures only, minus everything reachable from haves.
 * - deepen-relative: `depth` is added to the client's current depth, which is read off
 *   the shallow boundaries it sent (boundary generation + 1).
 * The exclusion walk from the haves stops at the client's shallow boundaries: a shallow
 * client holds the boundary commit itself, not its ancestors — without this, a deepen
 * would exclude the very parent it is asking for.
 * Returns the objects plus the new shallow boundary and the boundaries that became unshallow.
 */
function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  shallowBoundaries: readonly string[],
  deepenRelative = false,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const boundarySet = new Set(shallowBoundaries);
  const excluded = new Set<string>();
  if (haves.length > 0) {
    const seen = new Set<string>();
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        if (boundarySet.has(oid)) continue; // shallow boundary: its parents are not held
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  }

  const included = new Map<string, GitObject>();
  let shallow: string[] = [];
  const unshallow: string[] = [];

  if (depth === undefined) {
    let reachable: Set<string>;
    try {
      reachable = collectReachable(wants, (id) => repo.objects.get(id));
    } catch {
      reachable = new Set<string>();
    }
    for (const oid of reachable) {
      if (excluded.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) included.set(oid, object);
    }
    return { objects: [...included.values()], shallow, unshallow };
  }

  // Generations of the commits within the fetch's depth (tags unwrap at the same
  // generation). Expansion stops at the boundary generation, so a depth-1 fetch of a
  // 200-commit repo touches one commit, not the whole history.
  let effectiveDepth = depth;
  if (deepenRelative) {
    // `deepen-relative`: depth is added to the client's current depth, read off the
    // shallow boundaries it sent (boundary generation + 1). A targeted walk finds
    // each boundary's generation without scanning the whole history.
    const generationOf = (target: string): number | undefined => {
      const seen = new Map<string, number>();
      const q: { oid: string; gen: number }[] = [];
      const visit = (oid: string, gen: number): void => {
        const object = repo.objects.get(oid);
        if (!object) return;
        if (object.type === 'tag') {
          visit(parseTag(object.data).object, gen);
          return;
        }
        if (object.type !== 'commit' || seen.has(oid)) return;
        seen.set(oid, gen);
        q.push({ oid, gen });
      };
      for (const want of wants) visit(want, 0);
      for (let i = 0; i < q.length; i += 1) {
        const item = q[i] as { oid: string; gen: number };
        if (item.oid === target) return item.gen;
        const object = repo.objects.get(item.oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) visit(parent, item.gen + 1);
        if (q.length > 100000) return undefined;
      }
      return seen.get(target);
    };
    let current = 1;
    for (const boundary of shallowBoundaries) {
      const gen = generationOf(boundary);
      if (gen !== undefined) current = Math.max(current, gen + 1);
    }
    effectiveDepth = current + depth;
  }
  const boundaryGen = effectiveDepth - 1;
  const commitGen = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  const unwrap = (oid: string, gen: number): void => {
    const object = repo.objects.get(oid);
    if (!object) return;
    if (object.type === 'tag') {
      unwrap(parseTag(object.data).object, gen);
      return;
    }
    if (object.type !== 'commit') return;
    if (commitGen.has(oid)) return;
    commitGen.set(oid, gen);
    queue.push({ oid, gen });
  };
  for (const want of wants) unwrap(want, 0);
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i] as { oid: string; gen: number };
    if (item.gen >= boundaryGen) continue;
    const object = repo.objects.get(item.oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!commitGen.has(parent)) {
        commitGen.set(parent, item.gen + 1);
        queue.push({ oid: parent, gen: item.gen + 1 });
      }
    }
  }
  for (const [oid, gen] of commitGen) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (!excluded.has(oid)) included.set(oid, object);
    const tree = parseCommit(object.data).tree;
    const closure = new Map<string, GitObject>();
    treeClosure(repo, tree, closure);
    for (const [cid, cobj] of closure) if (!excluded.has(cid)) included.set(cid, cobj);
    if (gen === boundaryGen && parseCommit(object.data).parents.length > 0) shallow.push(oid);
  }
  // tag objects the wants named ride along
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag' && !excluded.has(want)) included.set(want, object);
  }
  shallow = [...new Set(shallow)].sort();
  for (const boundary of shallowBoundaries) {
    const gen = commitGen.get(boundary);
    if (gen === undefined) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((p) => commitGen.has(p))) unshallow.push(boundary);
  }
  return { objects: [...included.values()], shallow, unshallow };
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(owner: string, repoName: string, repo: Repo, args: readonly string[]): Buffer {
  const cacheKey = `${owner}/${repoName}|${args.join('\n')}`;
  const fp = refFingerprint(repo);
  const cached = lsRefsCache.get(cacheKey);
  if (cached !== undefined && cached.fp === fp) return cached.buf;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (keep('HEAD')) {
    if (head !== undefined) {
      parts.push(pkt(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  const buf = Buffer.concat(parts);
  lsRefsCache.set(cacheKey, { fp, buf });
  return buf;
}

// ---------------------------------------------------------------------------
// fetch (v2 + v0)
// ---------------------------------------------------------------------------

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += PKT_MAX_PAYLOAD - 1) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + PKT_MAX_PAYLOAD - 1));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

/** True when every OID a fetch names already exists in the store (cache-safety gate). */
function fetchCacheable(repo: Repo, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[]): boolean {
  for (const oid of wants) if (!repo.objects.has(oid)) return false;
  for (const oid of haves) if (!repo.objects.has(oid)) return false;
  for (const oid of shallowIn) if (!repo.objects.has(oid)) return false;
  return true;
}

function handleFetchV2(owner: string, repoName: string, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  let done = false;
  let deepenRelative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const key = fetchCacheKey('v2', owner, repoName, wants, haves, shallowIn, depth, deepenRelative, done);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const cacheable = fetchCacheable(repo, wants, haves, shallowIn);
  const { objects, shallow, unshallow } = selectFetchObjects(repo, wants, haves, depth, shallowIn, deepenRelative);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // Protocol v2 fetch response: sections separated by delim (0001), the response
  // ends with a flush (0000). The acknowledgments section is sent ONLY while the
  // client is still negotiating (no 'done' yet): a client that already sent 'done'
  // expects the packfile section first — real git dies with
  // "expected 'packfile', received 'acknowledgments'" otherwise.
  if (!done) {
    const acked = haves.filter((h) => repo.objects.has(h));
    parts.push(pkt('acknowledgments\n'));
    if (acked.length === 0) parts.push(pkt('NAK\n'));
    else for (const oid of acked) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'), DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  if (cacheable) fetchCacheStore(key, out);
  return out;
}

function handleFetchV0(owner: string, repoName: string, repo: Repo, lines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
    else if (text === 'deepen-relative') deepenRelative = true;
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  // v0 fetches carry no 'done' line; the response shape is fixed for a given key.
  const key = fetchCacheKey('v0', owner, repoName, wants, haves, shallowIn, depth, deepenRelative, true);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const cacheable = fetchCacheable(repo, wants, haves, shallowIn);
  const { objects, shallow, unshallow } = selectFetchObjects(repo, wants, haves, depth, shallowIn, deepenRelative);
  const pack = writePack(objects);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  if (cacheable) fetchCacheStore(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = decodePktLines(body);
  const lines = pktLinesText(packets);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = (lines[i] as string).replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        sideband = caps.split(' ').includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const packBytes = body.subarray(consumed);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  } else if (hasUpdates) {
    // A bare command list with no pack: git's receive-pack reports an unpacker error.
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }

  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = true;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          ok = false;
          reason = 'no such ref';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else {
          repo.refs.delete(command.ref);
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          ok = false;
          reason = 'already exists';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'object not found';
        } else {
          repo.refs.set(command.ref, command.newOid);
        }
      } else {
        if (current === undefined) {
          ok = false;
          reason = 'no such ref';
        } else if (command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'object not found';
        } else {
          let ff = false;
          try {
            ff = isAncestor(repo, command.oldOid, command.newOid);
          } catch {
            ff = false;
          }
          if (!ff) {
            ok = false;
            reason = 'non-fast-forward';
          } else {
            repo.refs.set(command.ref, command.newOid);
          }
        }
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
  }
  const inner = Buffer.concat([...reportLines.map((l) => pkt(l)), FLUSH]);
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += PKT_MAX_PAYLOAD - 1) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + PKT_MAX_PAYLOAD - 1));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  return Buffer.concat([inner]);
}

/** True when `ancestor` is an ancestor of `descendant` (or equal), walking parents. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
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
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
    guard += 1;
    if (guard > 200000) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const JSON_404 = (message: string): GitResponse => ({
  status: 404,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
});

export function handleGit(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitResponse {
  // pathname: /{owner}/{repo}.git[/info/refs|/git-upload-pack|/git-receive-pack]
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return JSON_404('Not Found');
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const suffix = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);

  if (method === 'GET' && suffix === '/info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return JSON_404('Not Found');
    if (!repo) return JSON_404('Not Found');
    const wantsV2 = service === 'git-upload-pack' && headers['git-protocol'] === 'version=2';
    const advertised = wantsV2 ? v2Advertisement() : v0AdvertisementCached(owner, repoName, repo, service);
    return {
      status: 200,
      headers: { 'content-type': `application/x-${service}-advertisement` },
      body: advertised,
    };
  }

  if (method === 'POST' && suffix === '/git-upload-pack') {
    if (!repo) return JSON_404('Not Found');
    const proto = headers['git-protocol'];
    if (proto === 'version=2') {
      const { packets } = decodePktLines(body);
      const lines = pktLinesText(packets);
      if (lines.length === 0 || !lines[0]?.startsWith('command=')) {
        return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('bad request\n') };
      }
      const command = (lines[0] as string).slice('command='.length).replace(/\n$/, '');
      const delimIndex = packets.findIndex((p) => p.kind === 'delim');
      const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
      const args = pktLinesText(argPackets).map((l) => l.replace(/\n$/, ''));
      let out: Buffer;
      if (command === 'ls-refs') out = handleLsRefs(owner, repoName, repo, args);
      else if (command === 'fetch') out = handleFetchV2(owner, repoName, repo, args);
      else {
        return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('unknown command\n') };
      }
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: out };
    }
    // v0 fetch
    const { packets } = decodePktLines(body);
    const lines = pktLinesText(packets);
    if (lines.length === 0) {
      return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('bad request\n') };
    }
    const out = handleFetchV0(owner, repoName, repo, lines);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: out };
  }

  if (method === 'POST' && suffix === '/git-receive-pack') {
    if (!repo) return JSON_404('Not Found');
    const out = handleReceivePack(repo, body);
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: out };
  }

  return JSON_404('Not Found');
}
