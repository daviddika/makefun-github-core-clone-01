// store.ts — the forge's single in-memory store. One process, one trial: every surface
// (REST v3, GraphQL v4, MCP, git smart HTTP) reads and writes this same store, so a
// mutation through any surface is visible through all the others (the suite cross-checks).
//
// Git objects are stored raw (Buffer) keyed by SHA-1, exactly as git hashes them:
// sha1("<type> <byte-length>\0" + data). Trees/commits/tags are built and parsed here;
// the pack layer only moves these bytes around.
//
// Determinism: all timestamps come from a logical clock (scenario epoch + a monotonic
// counter), never Date.now() — a live run and its replay must behave identically.

import { createHash } from 'node:crypto';
import { VIEWER, SCENARIO_EPOCH_SEC } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, Label>;
  comments: IssueComment[];
  commentSeq: number;
  shallow: Set<string>;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Parse a raw tree object into its entries (kept in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a raw commit object. Header continuation lines (leading space) are folded. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const lines = head.split('\n');
  const headers: [string, string][] = [];
  for (const line of lines) {
    if (line.startsWith(' ') && headers.length > 0) {
      const last = headers[headers.length - 1] as [string, string];
      last[1] += `\n${line}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space > 0) headers.push([line.slice(0, space), line.slice(space + 1)]);
  }
  const tree = headers.find(([k]) => k === 'tree')?.[1] ?? ZERO_OID;
  const parents = headers.filter(([k]) => k === 'parent').map(([, v]) => v.trim());
  const author = headers.find(([k]) => k === 'author')?.[1] ?? '';
  const committer = headers.find(([k]) => k === 'committer')?.[1] ?? '';
  return { tree, parents, author, committer, message };
}

/** Git tree sort order: entries by name, directories compared as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Count added/deleted lines between two texts (common prefix/suffix trimmed). */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return { additions: newLines.length - prefix - suffix, deletions: oldLines.length - prefix - suffix };
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return b64(`repo:${repo.id}`);
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`issue:${repo.id}:${issue.number}`);
}
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`pr:${repo.id}:${pull.number}`);
}
export function commentGlobalId(repo: Repo, comment: IssueComment): string {
  return b64(`comment:${repo.id}:${comment.id}`);
}

/** Decode an opaque global id back to {kind, repoId, number}. Returns null when malformed. */
export function parseGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    const number = parts.length > 2 ? Number(parts[2]) : 0;
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
    return { kind, repoId, number };
  } catch {
    return null;
  }
}

let repoIdSeq = 0;

export class Store {
  repos = new Map<string, Repo>();
  /** Logical clock: seconds past the scenario epoch; +1 per timestamp issued. */
  #clock = 0;
  #seq = 0;

  nowIso(): string {
    this.#clock += 1;
    return new Date((SCENARIO_EPOCH_SEC + this.#clock) * 1000).toISOString();
  }

  nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  viewerLogin(): string {
    return VIEWER.login;
  }

  // ---------------------------------------------------------- repositories

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    repoIdSeq += 1;
    const repo: Repo = {
      id: repoIdSeq,
      owner: VIEWER.login,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      labels: new Map(),
      comments: [],
      commentSeq: 0,
      shallow: new Set(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid.toLowerCase());
  }

  /** Build (and store) the tree for a flat path -> {oid, mode} file map. */
  buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // Group files by first path segment, recursively.
    const build = (paths: Map<string, { oid: string; mode: string }>): string => {
      const direct: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, file] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          direct.push({ mode: file.mode, name: path, oid: file.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(rest, file);
        }
      }
      for (const [dir, sub] of dirs) direct.push({ mode: '40000', name: dir, oid: build(sub) });
      direct.sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
      const chunks: Buffer[] = [];
      for (const entry of direct) {
        chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
        chunks.push(Buffer.from(entry.oid, 'hex'));
      }
      const data = Buffer.concat(chunks);
      return this.putObject(repo, 'tree', data);
    };
    return build(files);
  }

  /** Flatten a tree object into path -> {oid, mode} (files only). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  createCommit(
    repo: Repo,
    opts: { tree: string; parents: string[]; message: string; author?: string; committer?: string },
  ): string {
    const stamp = SCENARIO_EPOCH_SEC + this.#clock;
    const who = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
    const author = opts.author ?? who;
    const committer = opts.committer ?? who;
    let text = `tree ${opts.tree}\n`;
    for (const parent of opts.parents) text += `parent ${parent}\n`;
    text += `author ${author}\ncommitter ${committer}\n\n${opts.message}`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  createTagObject(
    repo: Repo,
    opts: { target: string; targetType: ObjType; tag: string; message: string },
  ): string {
    const stamp = SCENARIO_EPOCH_SEC + this.#clock;
    const tagger = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
    const text =
      `object ${opts.target}\ntype ${opts.targetType}\ntag ${opts.tag}\ntagger ${tagger}\n\n${opts.message}`;
    return this.putObject(repo, 'tag', Buffer.from(text, 'utf8'));
  }

  // ---------------------------------------------------------- refs

  getRef(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  setRef(repo: Repo, refname: string, oid: string): void {
    repo.refs.set(refname, oid);
  }

  deleteRef(repo: Repo, refname: string): boolean {
    return repo.refs.delete(refname);
  }

  listRefs(repo: Repo): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** Resolve HEAD, a full ref, a short branch name, or a raw 40-hex oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    const asTag = repo.refs.get(`refs/tags/${ref}`);
    if (asTag !== undefined) return asTag;
    if (/^[0-9a-f]{40}$/i.test(ref) && this.getObject(repo, ref) !== undefined) return ref.toLowerCase();
    return null;
  }

  headOid(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  // ---------------------------------------------------------- ancestry

  /** All commit oids reachable from `tip` (including tip itself). */
  commitAncestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = this.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      seen.add(oid);
      const info = parseCommit(obj.data);
      for (const parent of info.parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.commitAncestors(repo, desc).has(anc);
  }

  /** First common ancestor by BFS from `b` over `a`'s ancestor set (linear histories: exact). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAnc = this.commitAncestors(repo, a);
    if (aAnc.has(b)) return b;
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAnc.has(oid)) return oid;
      const obj = this.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest-first (parent order, DFS). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = this.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return out;
  }

  /**
   * All object oids reachable from `tips` (commits, their trees/blobs, tags and tag
   * targets), minus anything reachable from `excludeTips`. Used for fetch pack building.
   */
  reachableObjects(repo: Repo, tips: string[], excludeTips: string[] = []): Set<string> {
    const excluded = new Set<string>();
    for (const tip of excludeTips) this.#collectReachable(repo, tip, excluded);
    const out = new Set<string>();
    for (const tip of tips) this.#collectReachable(repo, tip, out);
    for (const oid of excluded) out.delete(oid);
    return out;
  }

  #collectReachable(repo: Repo, tip: string, into: Set<string>): void {
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (into.has(oid)) continue;
      const obj = this.getObject(repo, oid);
      if (obj === undefined) continue;
      into.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})\n/m.exec(obj.data.toString('utf8'));
        if (m !== null) stack.push(m[1] as string);
      }
    }
  }

  /** Diff base tree -> head tree, with per-file line counts. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string): FileChange[] {
    const base = baseTreeOid === null ? new Map() : this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const out: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const content = this.getObject(repo, h.oid)?.data.toString('utf8') ?? '';
        const additions = splitLines(content).length;
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const content = this.getObject(repo, b.oid)?.data.toString('utf8') ?? '';
        const deletions = splitLines(content).length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const oldText = this.getObject(repo, b.oid)?.data.toString('utf8') ?? '';
        const newText = this.getObject(repo, h.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = countLineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return out;
  }

  // ---------------------------------------------------------- contents API

  /** Read a file's blob at a ref; null when the ref/path does not exist. */
  readFileAt(repo: Repo, ref: string, path: string): { oid: string; content: Buffer } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const obj = this.getObject(repo, tip);
    if (obj === undefined || obj.type !== 'commit') return null;
    const tree = parseCommit(obj.data).tree;
    const files = this.flattenTree(repo, tree);
    const file = files.get(path);
    if (file === undefined) return null;
    const blob = this.getObject(repo, file.oid);
    if (blob === undefined) return null;
    return { oid: file.oid, content: blob.data };
  }

  /** Read a tree (or a subtree) at a ref; null when the ref/path is not a tree. */
  readTreeAt(repo: Repo, ref: string, path: string): { oid: string; entries: TreeEntry[] } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const obj = this.getObject(repo, tip);
    if (obj === undefined || obj.type !== 'commit') return null;
    let treeOid = parseCommit(obj.data).tree;
    if (path !== '') {
      const files = this.flattenTree(repo, treeOid);
      // Find the subtree oid by walking the tree entries.
      const parts = path.split('/');
      let current = treeOid;
      for (const part of parts) {
        const cur = this.getObject(repo, current);
        if (cur === undefined || cur.type !== 'tree') return null;
        const entry = parseTree(cur.data).find((e) => e.name === part && e.mode === '40000');
        if (entry === undefined) return null;
        current = entry.oid;
      }
      treeOid = current;
      void files;
    }
    const treeObj = this.getObject(repo, treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    return { oid: treeOid, entries: parseTree(treeObj.data) };
  }

  putContent(
    repo: Repo,
    opts: { branch: string; path: string; content: Buffer; message: string; sha?: string },
  ): { commitSha: string; blobSha: string } | { error: 'stale-sha' | 'not-found' } {
    const refname = `refs/heads/${opts.branch}`;
    const tip = repo.refs.get(refname) ?? null;
    let files = new Map<string, { oid: string; mode: string }>();
    let parents: string[] = [];
    if (tip !== null) {
      const obj = this.getObject(repo, tip);
      if (obj === undefined || obj.type !== 'commit') return { error: 'not-found' };
      files = this.flattenTree(repo, parseCommit(obj.data).tree);
      parents = [tip];
    }
    const existing = files.get(opts.path);
    if (opts.sha !== undefined) {
      if (existing === undefined || existing.oid.toLowerCase() !== opts.sha.toLowerCase()) {
        return { error: 'stale-sha' };
      }
    }
    const blobSha = this.putObject(repo, 'blob', opts.content);
    files.set(opts.path, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTree(repo, files);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents, message: opts.message });
    repo.refs.set(refname, commitSha);
    return { commitSha, blobSha };
  }

  deleteContent(
    repo: Repo,
    opts: { branch: string; path: string; message: string; sha: string },
  ): { commitSha: string } | { error: 'stale-sha' | 'not-found' } {
    const refname = `refs/heads/${opts.branch}`;
    const tip = repo.refs.get(refname) ?? null;
    if (tip === null) return { error: 'not-found' };
    const obj = this.getObject(repo, tip);
    if (obj === undefined || obj.type !== 'commit') return { error: 'not-found' };
    const files = this.flattenTree(repo, parseCommit(obj.data).tree);
    const existing = files.get(opts.path);
    if (existing === undefined || existing.oid.toLowerCase() !== opts.sha.toLowerCase()) {
      return { error: existing === undefined ? 'not-found' : 'stale-sha' };
    }
    files.delete(opts.path);
    const treeOid = this.buildTree(repo, files);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents: [tip], message: opts.message });
    repo.refs.set(refname, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { name, color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------- issues

  createIssue(
    repo: Repo,
    opts: { title: string; body: string; labels: string[] },
  ): Issue | { error: 'bad-label'; label: string } {
    for (const name of opts.labels) {
      if (!repo.labels.has(name)) return { error: 'bad-label', label: name };
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      id: repo.issueSeq,
      number: repo.issueSeq,
      title: opts.title,
      body: opts.body,
      state: 'open',
      labels: [...opts.labels],
      user: VIEWER.login,
      createdSeq: this.nextSeq(),
      updatedSeq: this.nextSeq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  listIssues(
    repo: Repo,
    opts: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    let out = [...repo.issues];
    if (opts.state === 'open' || opts.state === 'closed') out = out.filter((i) => i.state === opts.state);
    const dir = opts.direction === 'asc' ? 1 : -1;
    out.sort((a, b) => (a.createdSeq - b.createdSeq) * dir);
    return out;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | null {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return null;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedSeq = this.nextSeq();
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === undefined) return null;
    repo.commentSeq += 1;
    const comment: IssueComment = {
      id: repo.commentSeq,
      issueNumber,
      body,
      user: VIEWER.login,
      createdSeq: this.nextSeq(),
    };
    repo.comments.push(comment);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): IssueComment[] {
    return repo.comments
      .filter((c) => c.issueNumber === issueNumber)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------- pull requests

  createPull(
    repo: Repo,
    opts: { head: string; base: string; title: string; body: string },
  ): Pull | { error: 'bad-head' | 'bad-base' } {
    const headSha = this.resolveRef(repo, opts.head);
    if (headSha === null) return { error: 'bad-head' };
    const baseSha = this.resolveRef(repo, opts.base);
    if (baseSha === null) return { error: 'bad-base' };
    repo.pullSeq += 1;
    const pull: Pull = {
      id: repo.pullSeq,
      number: repo.pullSeq,
      title: opts.title,
      body: opts.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: opts.head,
      base: opts.base,
      headSha,
      baseSha,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  listPulls(repo: Repo, state: string | undefined): Pull[] {
    const out = [...repo.pulls];
    if (state === undefined || state === 'open') return out.filter((p) => p.state === 'open');
    if (state === 'closed') return out.filter((p) => p.state === 'closed');
    return out;
  }

  /** Files changed by a PR: merge-base(base, head) tree -> head tree. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const base = this.mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
    const baseObj = this.getObject(repo, base);
    const headObj = this.getObject(repo, pull.headSha);
    if (baseObj === undefined || headObj === undefined) return [];
    if (baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
    return this.diffTrees(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree);
  }

  /** Mergeable state: MERGEABLE when a clean three-way merge exists, else CONFLICTING. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const check = this.#threeWay(repo, pull);
    if (check === null) return 'UNKNOWN';
    return check.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  #threeWay(
    repo: Repo,
    pull: Pull,
  ): { files: Map<string, { oid: string; mode: string }>; conflicts: string[] } | null {
    const baseTip = this.resolveRef(repo, pull.base);
    const headTip = this.resolveRef(repo, pull.head);
    if (baseTip === null || headTip === null) return null;
    const baseObj = this.getObject(repo, baseTip);
    const headObj = this.getObject(repo, headTip);
    if (baseObj === undefined || headObj === undefined) return null;
    if (baseObj.type !== 'commit' || headObj.type !== 'commit') return null;
    const mergeBaseOid = this.mergeBase(repo, baseTip, headTip);
    const baseTree =
      mergeBaseOid === null
        ? new Map<string, { oid: string; mode: string }>()
        : this.flattenTree(repo, parseCommit((this.getObject(repo, mergeBaseOid)?.data ?? Buffer.alloc(0))).tree);
    const ours = this.flattenTree(repo, parseCommit(baseObj.data).tree);
    const theirs = this.flattenTree(repo, parseCommit(headObj.data).tree);
    const files = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set([...baseTree.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(o, t)) {
        if (o !== undefined) files.set(path, o);
      } else if (same(b, o)) {
        if (t !== undefined) files.set(path, t);
      } else if (same(b, t)) {
        if (o !== undefined) files.set(path, o);
      } else {
        conflicts.push(path);
      }
    }
    return { files, conflicts };
  }

  mergePull(
    repo: Repo,
    pull: Pull,
    method: string,
  ): { sha: string; message: string } | { error: 'conflict' | 'not-open' } {
    if (pull.state !== 'open') return { error: 'not-open' };
    const merged = this.#threeWay(repo, pull);
    if (merged === null) return { error: 'conflict' };
    if (merged.conflicts.length > 0) return { error: 'conflict' };
    const baseTip = this.resolveRef(repo, pull.base) as string;
    const headTip = this.resolveRef(repo, pull.head) as string;
    const treeOid = this.buildTree(repo, merged.files);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message =
      method === 'squash'
        ? `${pull.title} (#${pull.number})`
        : `Merge pull request #${pull.number} from ${pull.head}`;
    const sha = this.createCommit(repo, { tree: treeOid, parents, message });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return { sha, message };
  }
}

export const store = new Store();
