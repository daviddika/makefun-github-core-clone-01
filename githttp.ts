// githttp.ts — git smart HTTP (upload-pack / receive-pack) for the forge.
//
// Node 22 stdlib only, no deps, no git binary. Deterministic: no
// Date.now()/Math.random(). TypeScript with erasable syntax only (Node
// type-stripping: no enums, no parameter properties, no namespaces).
//
// Routes (all require authentication; unknown repos answer 404):
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack
//   GET  /<owner>/<repo>.git/info/refs?service=git-receive-pack
//   POST /<owner>/<repo>.git/git-upload-pack
//   POST /<owner>/<repo>.git/git-receive-pack
//
// Protocol v2 is served for upload-pack when the client sends
// `Git-Protocol: version=2`; receive-pack is v0 only. Every handler is
// wrapped so a malformed body answers 400/500 and the server keeps serving.

import { ZERO_OID, parseCommit, parseTree, type Repo, type Store } from './store.ts';
import { PKT_DELIM, PKT_FLUSH, buildPack, parsePack, parsePktLines, pktLine, sidebandWrap } from './gitpack.ts';
import { sendBuffer, sendJson, type Ctx } from './http.ts';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const AGENT = 'makefun-forge/1.0';

const UPLOAD_PACK_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_PACK_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

/** The branch HEAD points at (the store's default branch). */
function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The tip HEAD resolves to, or the first branch tip when the default branch is unborn. */
function headTip(store: Store, repo: Repo): string | null {
  const main = store.getRef(repo, headRefName(repo));
  if (main !== undefined) return main;
  for (const ref of store.listRefs(repo)) {
    if (ref.name.startsWith('refs/heads/')) return ref.oid;
  }
  return null;
}

/**
 * Peel an annotated tag to the object it ultimately points at (following
 * tag -> tag chains). Returns null when `oid` is not a tag object, when the
 * target is missing, or when the chain does not end in a non-tag object.
 */
function peelTag(store: Store, repo: Repo, oid: string): string | null {
  const first = store.getObject(repo, oid);
  if (first === undefined || first.type !== 'tag') return null;
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const obj = store.getObject(repo, current);
    if (obj === undefined || obj.type !== 'tag') return null;
    const m = /^object ([0-9a-f]{40})\n/m.exec(obj.data.toString('utf8'));
    if (m === null) return null;
    const target = m[1] as string;
    const targetObj = store.getObject(repo, target);
    if (targetObj === undefined) return null;
    if (targetObj.type !== 'tag') return target;
    current = target;
  }
  return null;
}

/** Narrow a pack object's string type to one of the four stored types. */
function asObjType(type: string): 'commit' | 'tree' | 'blob' | 'tag' | null {
  if (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag') return type;
  return null;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

/** v0 ref advertisement: service preamble, then ref lines (first carries the caps). */
function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const branch = headRefName(repo);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${branch} side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}`
      : `symref=HEAD:${branch} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    // An empty repo advertises a single pseudo-ref carrying the capabilities.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const emit = (line: string): void => {
      parts.push(pktLine(first ? `${line}\0${caps}\n` : `${line}\n`));
      first = false;
    };
    const head = headTip(store, repo);
    if (head !== null) emit(`${head} HEAD`);
    for (const ref of refs) {
      emit(`${ref.oid} ${ref.name}`);
      // A peeled line must follow its base ref line.
      const peeled = peelTag(store, repo, ref.oid);
      if (peeled !== null) emit(`${peeled} ${ref.name}^{}`);
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function handleInfoRefs(ctx: Ctx, repo: Repo): void {
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(ctx.res, 400, { message: 'Bad Request' }, ctx.requestId);
    return;
  }
  if (service === 'git-receive-pack') {
    // Receive-pack is v0 only, whatever the client asked for.
    sendBuffer(ctx.res, 200, v0Advertisement(ctx.store, repo, service), RECEIVE_PACK_AD);
    return;
  }
  if (ctx.req.headers['git-protocol'] === 'version=2') {
    sendBuffer(ctx.res, 200, v2Advertisement(), UPLOAD_PACK_AD);
  } else {
    sendBuffer(ctx.res, 200, v0Advertisement(ctx.store, repo, service), UPLOAD_PACK_AD);
  }
}

// ---------------------------------------------------------------------------
// fetch planning: which objects a fetch sends
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Object ids to pack, sorted for determinism. */
  oids: string[];
  /** New shallow boundaries ("shallow <oid>" lines). */
  shallow: string[];
  /** Old shallow boundaries that are now fully included ("unshallow <oid>"). */
  unshallow: string[];
}

/**
 * Objects the client already holds, from its 'have' lines: each have
 * object plus everything reachable from it — except that the walk
 * stops at a shallow boundary (the client holds the boundary commit
 * and its tree, but not its parents). A 'have' that is not a shallow
 * boundary contributes its full ancestry. This is what makes a deepen
 * past a boundary deliver the ancestors the client is still missing,
 * instead of treating a shallow 'have' as if it carried its history.
 */
function heldObjects(
  store: Store,
  repo: Repo,
  haves: string[],
  shallowReq: string[],
): Set<string> {
  const shallow = new Set(shallowReq);
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!shallow.has(oid)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue; // gitlink: a commit the repo does not hold
        stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})\n/m.exec(obj.data.toString('utf8'));
      if (m !== null) stack.push(m[1] as string);
    }
  }
  return held;
}

/**
 * Depth-limited reachability from `tips`: commits within `depth`
 * generations of a tip (depth 1 = the tips only), each with its full tree
 * and blobs. Tag tips resolve to their target commit at distance 0.
 * Commits/tags the client already holds are not re-sent; the trees and
 * blobs of the included commits are kept, so every included tree stays
 * closed in the pack.
 */
function collectDepthLimited(
  store: Store,
  repo: Repo,
  tips: string[],
  depth: number,
  held: Set<string>,
  shallowReq: string[],
): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const objects = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  let head = 0;
  const seenCommit = new Set<string>();

  const includeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (objects.has(oid)) continue;
      const obj = store.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'tree') continue;
      objects.add(oid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue; // gitlink: a commit the repo does not hold
        const child = store.getObject(repo, entry.oid);
        if (child === undefined) continue;
        if (child.type === 'tree') stack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  };

  const enqueueRoot = (tip: string): void => {
    let current = tip;
    for (let hops = 0; hops < 10; hops += 1) {
      const obj = store.getObject(repo, current);
      if (obj === undefined) return;
      if (obj.type === 'tag') {
        objects.add(current);
        const m = /^object ([0-9a-f]{40})\n/m.exec(obj.data.toString('utf8'));
        if (m === null) return;
        current = m[1] as string;
        continue;
      }
      if (obj.type === 'commit') {
        queue.push({ oid: current, dist: 0 });
        return;
      }
      if (obj.type === 'tree') {
        includeTree(current);
        return;
      }
      objects.add(current);
      return;
    }
  };

  for (const tip of tips) enqueueRoot(tip);
  // FIFO queue: commits are dequeued in non-decreasing distance, so the
  // first visit of a commit is at its shortest distance from a tip.
  while (head < queue.length) {
    const item = queue[head] as { oid: string; dist: number };
    head += 1;
    if (seenCommit.has(item.oid)) continue;
    if (item.dist >= depth) continue;
    const obj = store.getObject(repo, item.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seenCommit.add(item.oid);
    objects.add(item.oid);
    const info = parseCommit(obj.data);
    includeTree(info.tree);
    for (const parent of info.parents) {
      if (!seenCommit.has(parent)) queue.push({ oid: parent, dist: item.dist + 1 });
    }
  }

  for (const oid of [...objects]) {
    if (!held.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj !== undefined && (obj.type === 'commit' || obj.type === 'tag')) objects.delete(oid);
  }

  // What the client will hold after this fetch: the sent objects plus
  // everything reachable from its (non-shallow) haves.
  const available = new Set<string>([...objects, ...held]);
  const shallow: string[] = [];
  for (const oid of objects) {
    const obj = store.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => !available.has(parent))) shallow.push(oid);
  }
  shallow.sort();
  const unshallow: string[] = [];
  for (const boundary of shallowReq) {
    const obj = store.getObject(repo, boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((parent) => available.has(parent))) unshallow.push(boundary);
  }
  unshallow.sort();
  return { objects, shallow, unshallow };
}

/**
 * Plan one fetch: the object ids to send and the shallow-info lines.
 */
function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  depth: number | null,
): FetchPlan {
  const held = heldObjects(store, repo, haves, shallowReq);
  if (depth !== null && depth > 0) {
    const res = collectDepthLimited(store, repo, wants, depth, held, shallowReq);
    return { oids: [...res.objects].sort(), shallow: res.shallow, unshallow: res.unshallow };
  }
  const oids = store.reachableObjects(repo, wants, []);
  for (const oid of held) oids.delete(oid);
  return { oids: [...oids].sort(), shallow: [], unshallow: [] };
}

/** Build a packfile from the planned object ids (sorted, plain objects). */
function buildFetchPack(store: Store, repo: Repo, oids: string[]): Buffer {
  const inputs: Array<{ oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> = [];
  for (const oid of oids) {
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    inputs.push({ oid, type: obj.type, data: obj.data });
  }
  return buildPack(inputs);
}

/** Record the repo's shallow boundaries after a fetch (cleared by a full fetch). */
function noteFetchDepth(repo: Repo, plan: FetchPlan, depth: number | null): void {
  repo.shallow.clear();
  if (depth !== null) {
    for (const oid of plan.shallow) repo.shallow.add(oid);
  }
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

/** v2 ls-refs: "<oid> <ref>[ symref-target:<t>][ peeled:<oid>]" lines, then a flush. */
function handleLsRefsV2(ctx: Ctx, repo: Repo, argLines: string[]): void {
  const store = ctx.store;
  const peel = argLines.includes('peel');
  const symrefs = argLines.includes('symrefs');
  const unborn = argLines.includes('unborn');
  const prefixes = argLines
    .filter((line) => line.startsWith('ref-prefix '))
    .map((line) => line.slice('ref-prefix '.length));
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const branch = headRefName(repo);
  const lines: string[] = [];
  const head = headTip(store, repo);
  if (head !== null) {
    lines.push(symrefs ? `${head} HEAD symref-target:${branch}` : `${head} HEAD`);
  } else if (unborn) {
    lines.push(symrefs ? `unborn HEAD symref-target:${branch}` : 'unborn HEAD');
  }
  for (const ref of store.listRefs(repo)) {
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelTag(store, repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const out: Buffer[] = [];
  for (const line of lines) {
    const name = line.split(' ')[1] ?? '';
    if (!keep(name)) continue;
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  sendBuffer(ctx.res, 200, Buffer.concat(out), UPLOAD_PACK_RESULT);
}

/** v2 fetch response.
 *
 * Ground truth is real git's upload-pack: the acknowledgments section
 * is sent only when the request carried 'have' lines and no 'done'
 * (with 'done' — or no haves — the response goes straight to the
 * packfile, and the client never expects an acknowledgments section).
 * Sections are separated by DELIM (0001) and the response ends with a
 * FLUSH (0000); a NAK-only negotiation reply is just the
 * acknowledgments section plus FLUSH. A 'ready' answer carries the
 * packfile in the same response. */
function sendV2Fetch(
  ctx: Ctx,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  depth: number | null,
  done: boolean,
): void {
  const store = ctx.store;
  const negotiate = haves.length > 0 && !done;
  if (negotiate) {
    const allHeld = haves.every((have) => store.getObject(repo, have) !== undefined);
    if (!allHeld) {
      // NAK only: the client will send another request with more haves.
      sendBuffer(
        ctx.res,
        200,
        Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]),
        UPLOAD_PACK_RESULT,
      );
      return;
    }
  }
  const plan = planFetch(store, repo, wants, haves, shallowReq, depth);
  const pack = buildFetchPack(store, repo, plan.oids);
  noteFetchDepth(repo, plan, depth);
  const sections: Buffer[][] = [];
  if (negotiate) {
    // Every have is held: ACK + ready, and the pack follows in this response.
    sections.push([
      pktLine('acknowledgments\n'),
      pktLine(`ACK ${haves[0]}\n`),
      pktLine('ready\n'),
    ]);
  }
  if (depth !== null && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    const lines: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of plan.shallow) lines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) lines.push(pktLine(`unshallow ${oid}\n`));
    sections.push(lines);
  }
  sections.push([pktLine('packfile\n'), sidebandWrap(1, pack)]);
  // Sections are separated by DELIM; the response ends with FLUSH.
  const out: Buffer[] = [];
  sections.forEach((section, index) => {
    out.push(...section);
    out.push(index === sections.length - 1 ? PKT_FLUSH : PKT_DELIM);
  });
  sendBuffer(ctx.res, 200, Buffer.concat(out), UPLOAD_PACK_RESULT);
}

/** v0 fetch: NAK/ACK and shallow lines as plain pkt-lines, then the sideband pack. */
function sendV0Fetch(
  ctx: Ctx,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowReq: string[],
  depth: number | null,
): void {
  const store = ctx.store;
  const plan = planFetch(store, repo, wants, haves, shallowReq, depth);
  const pack = buildFetchPack(store, repo, plan.oids);
  noteFetchDepth(repo, plan, depth);
  const chunks: Buffer[] = [];
  if (haves.length > 0 && haves.every((have) => store.getObject(repo, have) !== undefined)) {
    chunks.push(pktLine(`ACK ${haves[0]}\n`));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  if (depth !== null) {
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  }
  chunks.push(sidebandWrap(1, pack));
  chunks.push(PKT_FLUSH);
  sendBuffer(ctx.res, 200, Buffer.concat(chunks), UPLOAD_PACK_RESULT);
}

/** Parse the argument lines of a v2 fetch request (after the delim). */
function parseFetchArgs(argLines: string[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'done') {
      done = true;
    } else if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (OID_RE.test(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (OID_RE.test(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (OID_RE.test(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since,
    // deepen-not: accepted and ignored.
  }
  return { wants, haves, shallow, depth, done };
}

function badRequest(ctx: Ctx): void {
  sendJson(ctx.res, 400, { message: 'Bad Request' }, ctx.requestId);
}

function handleUploadPack(ctx: Ctx, repo: Repo): void {
  let parsed: { lines: Array<{ kind: string; data: Buffer }>; consumed: number };
  try {
    parsed = parsePktLines(ctx.body);
  } catch {
    badRequest(ctx);
    return;
  }
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
  if (isV2) {
    const pkts = parsed.lines.map((line) => ({
      kind: line.kind,
      text: line.kind === 'data' ? line.data.toString('utf8') : '',
    }));
    const delimIdx = pkts.findIndex((packet) => packet.kind === 'delim');
    const headLines = (delimIdx >= 0 ? pkts.slice(0, delimIdx) : pkts).map((packet) => packet.text);
    const argLines = (delimIdx >= 0 ? pkts.slice(delimIdx + 1) : [])
      .map((packet) => packet.text)
      .filter((text) => text !== '')
      .map((text) => text.replace(/\n$/, ''));
    const commandLine = headLines.find((text) => text.startsWith('command='));
    const command =
      commandLine === undefined ? '' : commandLine.slice('command='.length).replace(/\n$/, '');
    if (command === 'ls-refs') {
      handleLsRefsV2(ctx, repo, argLines);
      return;
    }
    if (command === 'fetch') {
      const args = parseFetchArgs(argLines);
      sendV2Fetch(ctx, repo, args.wants, args.haves, args.shallow, args.depth, args.done);
      return;
    }
    badRequest(ctx);
    return;
  }

  // v0: two pkt-line sections — wants (with shallow/deepen), then haves —
  // each terminated by a flush. parsePktLines stops at the first flush, so
  // the haves section is parsed from the bytes that follow it.
  const wantTexts = parsed.lines
    .filter((line) => line.kind === 'data')
    .map((line) => line.data.toString('utf8').replace(/\n$/, ''));
  let haveTexts: string[] = [];
  if (parsed.consumed < ctx.body.length) {
    try {
      const second = parsePktLines(ctx.body.subarray(parsed.consumed));
      haveTexts = second.lines
        .filter((line) => line.kind === 'data')
        .map((line) => line.data.toString('utf8').replace(/\n$/, ''));
    } catch {
      haveTexts = [];
    }
  }
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of wantTexts) {
    if (line.startsWith('want ')) {
      // The first want line carries the capability list after the oid.
      const oid = (line.slice(5).split(' ')[0] as string) ?? '';
      if (OID_RE.test(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (OID_RE.test(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const haves: string[] = [];
  for (const line of haveTexts) {
    if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (OID_RE.test(oid)) haves.push(oid);
    }
  }
  sendV0Fetch(ctx, repo, wants, haves, shallow, depth);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

/**
 * Apply one ref-update command. Returns 'ok', or the refusal reason for
 * the report-status `ng` line. A refused update never moves the ref; the
 * pack's objects stay stored either way.
 */
function applyRefUpdate(
  store: Store,
  repo: Repo,
  cmd: { oldOid: string; newOid: string; ref: string },
): string {
  const current = store.getRef(repo, cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'remote ref does not exist';
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return 'non-fast-forward';
    store.deleteRef(repo, cmd.ref);
    return 'ok';
  }
  if (store.getObject(repo, cmd.newOid) === undefined) return 'non-fast-forward';
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    store.setRef(repo, cmd.ref, cmd.newOid);
    return 'ok';
  }
  // Update: the old value must be the current tip and an ancestor of the new tip.
  if (current === undefined) return 'non-fast-forward';
  if (cmd.oldOid !== current) return 'non-fast-forward';
  if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) return 'non-fast-forward';
  store.setRef(repo, cmd.ref, cmd.newOid);
  return 'ok';
}

async function handleReceivePack(ctx: Ctx, repo: Repo): Promise<void> {
  const store = ctx.store;
  let parsed: { lines: Array<{ kind: string; data: Buffer }>; consumed: number };
  try {
    // parsePktLines stops at the flush ending the command list, so the
    // bytes at `consumed` are the raw packfile that follows it.
    parsed = parsePktLines(ctx.body);
  } catch {
    badRequest(ctx);
    return;
  }
  const flushIdx = parsed.lines.findIndex((line) => line.kind === 'flush');
  if (flushIdx < 0) {
    badRequest(ctx);
    return;
  }
  const cmdTexts = parsed.lines
    .slice(0, flushIdx)
    .filter((line) => line.kind === 'data')
    .map((line) => line.data.toString('utf8'));
  if (cmdTexts.length === 0) {
    badRequest(ctx);
    return;
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let caps = '';
  for (let i = 0; i < cmdTexts.length; i += 1) {
    let line = (cmdTexts[i] as string).replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m === null) {
      badRequest(ctx);
      return;
    }
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  const sideband = caps.split(' ').includes('side-band-64k');

  // The pack follows the command-list flush directly (no pkt framing).
  // A delete-only command list carries no pack at all.
  const packBytes = ctx.body.subarray(parsed.consumed);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      // Thin packs resolve their delta bases against objects the server
      // already holds.
      const objects = await parsePack(packBytes, (oid) => store.getObject(repo, oid));
      for (const obj of objects.values()) {
        const type = asObjType(obj.type);
        if (type === null) continue;
        store.putObject(repo, type, obj.data);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/[\r\n]+/g, ' ').slice(0, 200) : '';
      unpackError = message === '' ? 'unpack failed' : message;
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  } else {
    // "unpack ok" is present even when a ref is refused.
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const verdict = applyRefUpdate(store, repo, cmd);
      if (verdict === 'ok') reportLines.push(`ok ${cmd.ref}\n`);
      else reportLines.push(`ng ${cmd.ref} ${verdict}\n`);
    }
  }
  const report = Buffer.concat([
    ...reportLines.map((line) => pktLine(line)),
    // The report-status stream itself ends with a flush: real git's
    // report reader reads pkt-lines until that flush, so without it the
    // reader runs past the report and the connection looks hung up.
    PKT_FLUSH,
  ]);
  const body = sideband
    ? Buffer.concat([sidebandWrap(1, report), PKT_FLUSH])
    : report;
  sendBuffer(ctx.res, 200, body, RECEIVE_PACK_RESULT);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Handle one git smart-HTTP request. Returns true (and sends a response)
 * when the path is /<owner>/<repo>.git/<info/refs|git-upload-pack|
 * git-receive-pack> with a valid owner/repo name; otherwise false, without
 * sending anything.
 */
export async function handleGit(ctx: Ctx): Promise<boolean> {
  const segments = ctx.segments;
  if (segments.length < 3) return false;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const repoName = repoSegment.slice(0, -4);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName)) return false;
  const rest = segments.slice(2);
  const isInfoRefs =
    ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs';
  const isUploadPack =
    ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack';
  const isReceivePack =
    ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;
  try {
    if (!ctx.authed) {
      sendJson(ctx.res, 401, { message: 'Requires authentication' }, ctx.requestId);
      return true;
    }
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(ctx.res, 404, { message: 'Not Found' }, ctx.requestId);
      return true;
    }
    if (isInfoRefs) {
      handleInfoRefs(ctx, repo);
      return true;
    }
    if (isUploadPack) {
      handleUploadPack(ctx, repo);
      return true;
    }
    await handleReceivePack(ctx, repo);
    return true;
  } catch {
    // Never let one request take the server down: answer 500 if nothing
    // was sent yet, and keep serving.
    if (!ctx.res.headersSent) {
      try {
        sendJson(ctx.res, 500, { message: 'Internal Server Error' }, ctx.requestId);
      } catch {
        // The response is already gone; nothing more can be sent.
      }
    }
    return true;
  }
}
