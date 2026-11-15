// rest.ts — GitHub REST API v3 layer for the forge (Node 22 stdlib only, no deps).
//
// Handler signature: (ctx) => Promise<boolean>; true = route matched and response
// sent, false = not an /api/v3 route (nothing sent). Every reply is JSON with
// X-GitHub-Request-Id (sendJson does both). Auth is checked here: every /api/v3
// route except GET /api/v3/ itself requires a valid token.

import { sendJson, parseJsonBody } from './http.ts';
import type { Ctx } from './http.ts';
import {
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  parseCommit,
  type Repo,
  type Issue,
  type Pull,
  type IssueComment,
} from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------- timestamps
// The store keeps only sequence numbers, so created_at/updated_at live in
// module-level caches keyed by the entity object. Set at creation, updated
// on patch/merge; reads are stable (no clock advance per read).

interface EntityTimes {
  createdAt: string;
  updatedAt: string;
}

const repoTimes = new WeakMap<Repo, EntityTimes>();
const issueTimes = new WeakMap<Issue, EntityTimes>();
const pullTimes = new WeakMap<Pull, EntityTimes>();
const commentTimes = new WeakMap<IssueComment, EntityTimes>();

function stampNew(ctx: Ctx, map: WeakMap<object, EntityTimes>, key: object): EntityTimes {
  const t = ctx.store.nowIso();
  const times: EntityTimes = { createdAt: t, updatedAt: t };
  map.set(key, times);
  return times;
}

function timesOf(map: WeakMap<object, EntityTimes>, key: object, fallback: string): EntityTimes {
  const t = map.get(key);
  if (t !== undefined) return t;
  return { createdAt: fallback, updatedAt: fallback };
}

// ---------------------------------------------------------- helpers

function err(ctx: Ctx, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, status, { message }, ctx.requestId, extra);
}

function ok(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, ctx.requestId, extra);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the request body as a JSON object; 400 on malformed/non-object body. */
function bodyObj(ctx: Ctx): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok || !isRecord(parsed.value)) return { ok: false };
  return { ok: true, value: parsed.value };
}

function badBody(ctx: Ctx): void {
  err(ctx, 400, 'Invalid JSON body');
}

function pageParams(ctx: Ctx): { perPage: number; page: number } {
  let perPage = Number(ctx.query.get('per_page') ?? '30');
  let page = Number(ctx.query.get('page') ?? '1');
  if (!Number.isFinite(perPage)) perPage = 30;
  if (!Number.isFinite(page)) page = 1;
  perPage = Math.min(100, Math.max(1, Math.floor(perPage)));
  page = Math.max(1, Math.floor(page));
  return { perPage, page };
}

function paginate<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/**
 * GitHub-style Link header with full URLs. Only rels that exist are included:
 * next (not on last page), prev (not on first page), first, last.
 */
function linkHeader(
  ctx: Ctx,
  path: string,
  baseParams: [string, string][],
  perPage: number,
  page: number,
  total: number,
): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const host = ctx.req.headers.host ?? 'localhost';
  const base = `http://${host}`;
  const mk = (p: number): string => {
    const q = [...baseParams, ['per_page', String(perPage)], ['page', String(p)]];
    const qs = q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return `${base}${path}?${qs}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${mk(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${mk(page - 1)}>; rel="prev"`);
  parts.push(`<${mk(1)}>; rel="first"`);
  parts.push(`<${mk(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function linkExtra(ctx: Ctx, names: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const name of names) {
    const v = ctx.query.get(name);
    if (v !== null) out.push([name, v]);
  }
  return out;
}

// ---------------------------------------------------------- serializers

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const times = timesOf(repoTimes, repo, '2025-01-01T00:00:00.000Z');
  const openCount =
    repo.issues.filter((i) => i.state === 'open').length +
    repo.pulls.filter((p) => p.state === 'open').length;
  const fullName = `${repo.owner}/${repo.name}`;
  const htmlUrl = `https://github.com/${fullName}`;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: times.createdAt,
    updated_at: times.updatedAt,
    html_url: htmlUrl,
    clone_url: `${htmlUrl}.git`,
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    homepage: '',
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openCount,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const names = [...repo.labels.keys()];
  const id = names.indexOf(name) + 1;
  return {
    id,
    node_id: `label:${repo.id}:${id}`,
    name,
    color: label?.color ?? '',
    description: label?.description ?? '',
  };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const times = timesOf(issueTimes, issue, '2025-01-01T00:00:00.000Z');
  let commentCount = 0;
  for (const c of repo.comments) if (c.issueNumber === issue.number) commentCount += 1;
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.user, id: VIEWER.id, type: 'User' },
    assignee: null,
    created_at: times.createdAt,
    updated_at: times.updatedAt,
    closed_at: null,
    comments: commentCount,
  };
}

function commentJson(ctx: Ctx, repo: Repo, comment: IssueComment): Record<string, unknown> {
  const times = timesOf(commentTimes, comment, '2025-01-01T00:00:00.000Z');
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, comment),
    body: comment.body,
    user: { login: comment.user, id: VIEWER.id, type: 'User' },
    created_at: times.createdAt,
    updated_at: times.updatedAt,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const times = timesOf(pullTimes, pull, '2025-01-01T00:00:00.000Z');
  const mergeable = ctx.store.pullMergeable(repo, pull);
  const fullName = `${repo.owner}/${repo.name}`;
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${VIEWER.login}:${ref}`,
    ref,
    sha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    repo: { name: repo.name, full_name: fullName },
  });
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: side(pull.head, pull.headSha),
    base: side(pull.base, pull.baseSha),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: times.createdAt,
    updated_at: times.updatedAt,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? times.updatedAt) : null,
    draft: false,
    mergeable: mergeable === 'MERGEABLE' ? true : mergeable === 'CONFLICTING' ? false : null,
  };
}

// ---------------------------------------------------------- git helpers

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: line, email: '', date: '2025-01-01T00:00:00.000Z' };
  const ts = Number(m[3] as string);
  return {
    name: m[1] as string,
    email: m[2] as string,
    date: new Date(ts * 1000).toISOString(),
  };
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---------------------------------------------------------- handler

export async function handleRest(ctx: Ctx): Promise<boolean> {
  const segments = ctx.segments;
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;

  // Drop a trailing empty segment from a trailing slash ("/api/v3/").
  const rest = segments.slice(2);
  while (rest.length > 0 && rest[rest.length - 1] === '') rest.pop();

  const method = ctx.method;

  // API root: the starter answers this without auth; keep that behavior.
  if (rest.length === 0) {
    if (method !== 'GET') {
      err(ctx, 404, 'Not Found');
      return true;
    }
    ok(
      ctx,
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // Every other /api/v3 route requires authentication.
  if (!ctx.authed) {
    err(ctx, 401, 'Requires authentication');
    return true;
  }

  const store = ctx.store;
  const owner = VIEWER.login;

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      err(ctx, 404, 'Not Found');
      return true;
    }
    ok(ctx, 200, { installed_version: '1.0.0' });
    return true;
  }

  // /api/v3/user/repos — create / list the token owner's repos.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = bodyObj(ctx);
      if (!parsed.ok) {
        badBody(ctx);
        return true;
      }
      const body = parsed.value;
      const name = body.name;
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > 100 ||
        name === '.' ||
        name === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(name)
      ) {
        err(ctx, 422, 'Invalid repository name');
        return true;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) {
        err(ctx, 422, 'Repository already exists');
        return true;
      }
      stampNew(ctx, repoTimes, repo);
      ok(ctx, 201, repoJson(ctx, repo));
      return true;
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(ctx);
      const all = store.listReposByOwner(owner);
      const link = linkHeader(ctx, '/api/v3/user/repos', [], perPage, page, all.length);
      ok(ctx, 200, paginate(all, perPage, page).map((r) => repoJson(ctx, r)), link === null ? {} : { link });
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[...].
  if (rest.length < 3 || rest[0] !== 'repos') {
    err(ctx, 404, 'Not Found');
    return true;
  }

  const repoOwner = rest[1] as string;
  const repoName = rest[2] as string;
  // Any owner other than the token owner's login is a 404 (never 403).
  const repo = repoOwner === owner ? store.getRepo(repoOwner, repoName) : undefined;
  if (repo === undefined) {
    err(ctx, 404, 'Not Found');
    return true;
  }
  const tail = rest.slice(3);

  // /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      ok(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = bodyObj(ctx);
      if (!parsed.ok) {
        badBody(ctx);
        return true;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      const times = repoTimes.get(repo);
      if (times !== undefined) times.updatedAt = store.nowIso();
      ok(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repoOwner, repoName);
      ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId, 'content-length': '0' });
      ctx.res.end();
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  // POST /api/v3/repos/{o}/{r}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const parsed = bodyObj(ctx);
    if (!parsed.ok) {
      badBody(ctx);
      return true;
    }
    const ref = parsed.value.ref;
    const sha = parsed.value.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
      err(ctx, 422, 'Invalid ref: must start with refs/');
      return true;
    }
    if (typeof sha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(sha)) {
      err(ctx, 422, 'Invalid sha');
      return true;
    }
    if (store.getObject(repo, sha) === undefined) {
      err(ctx, 422, 'Unknown object sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      err(ctx, 422, 'Reference already exists');
      return true;
    }
    store.setRef(repo, ref, sha.toLowerCase());
    ok(ctx, 201, { ref, object: { sha: sha.toLowerCase() } });
    return true;
  }

  // GET /api/v3/repos/{o}/{r}/branches
  if (tail.length === 1 && tail[0] === 'branches') {
    if (method !== 'GET') {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const branches = store
      .listRefs(repo)
      .filter((r) => r.name.startsWith('refs/heads/'))
      .map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.oid } }));
    ok(ctx, 200, branches);
    return true;
  }

  // GET /api/v3/repos/{o}/{r}/commits[?sha=<ref>]
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const commits = store.listCommits(repo, tip).map((sha) => {
      const obj = store.getObject(repo, sha);
      const info = obj !== undefined ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
      return {
        sha,
        commit: {
          message: info.message.replace(/\n+$/, ''),
          author: parseIdent(info.author),
          committer: parseIdent(info.committer),
        },
        parents: info.parents.map((p) => ({ sha: p })),
        author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      };
    });
    ok(ctx, 200, commits);
    return true;
  }

  // /api/v3/repos/{o}/{r}/contents/{path...}
  if (tail.length >= 1 && tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const file = store.readFileAt(repo, ref, path);
      if (file !== null) {
        ok(ctx, 200, {
          type: 'file',
          encoding: 'base64',
          content: file.content.toString('base64'),
          sha: file.oid,
          size: file.content.length,
          name: basename(path),
          path,
        });
        return true;
      }
      const tree = store.readTreeAt(repo, ref, path);
      if (tree !== null) {
        const prefix = path === '' ? '' : `${path}/`;
        ok(
          ctx,
          200,
          tree.entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${prefix}${e.name}`,
            sha: e.oid,
          })),
        );
        return true;
      }
      err(ctx, 404, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const parsed = bodyObj(ctx);
      if (!parsed.ok) {
        badBody(ctx);
        return true;
      }
      const body = parsed.value;
      const content = body.content;
      if (typeof content !== 'string' || !BASE64_RE.test(content)) {
        err(ctx, 422, 'Invalid base64 content');
        return true;
      }
      const message = typeof body.message === 'string' ? body.message : '';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = store.putContent(repo, {
        branch,
        path,
        content: Buffer.from(content, 'base64'),
        message,
        sha,
      });
      if ('error' in result) {
        if (result.error === 'stale-sha') err(ctx, 409, 'Conflict: sha does not match the current file');
        else err(ctx, 404, 'Not Found');
        return true;
      }
      const status = sha === undefined ? 201 : 200;
      ok(ctx, status, {
        content: {
          sha: result.blobSha,
          encoding: 'base64',
          name: basename(path),
          path,
          size: Buffer.from(content, 'base64').length,
        },
        commit: { sha: result.commitSha },
      });
      return true;
    }
    if (method === 'DELETE') {
      const parsed = bodyObj(ctx);
      if (!parsed.ok) {
        badBody(ctx);
        return true;
      }
      const body = parsed.value;
      const sha = body.sha;
      if (typeof sha !== 'string') {
        err(ctx, 422, 'Missing sha');
        return true;
      }
      const message = typeof body.message === 'string' ? body.message : '';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const result = store.deleteContent(repo, { branch, path, message, sha });
      if ('error' in result) {
        if (result.error === 'stale-sha') err(ctx, 409, 'Conflict: sha does not match the current file');
        else err(ctx, 404, 'Not Found');
        return true;
      }
      ok(ctx, 200, { commit: { sha: result.commitSha } });
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  // POST /api/v3/repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method !== 'POST') {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const parsed = bodyObj(ctx);
    if (!parsed.ok) {
      badBody(ctx);
      return true;
    }
    const name = parsed.value.name;
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : '';
    if (typeof name !== 'string' || name.length === 0) {
      err(ctx, 422, 'Invalid label name');
      return true;
    }
    const label = store.createLabel(repo, name, color);
    if (label === null) {
      err(ctx, 422, 'Label already exists');
      return true;
    }
    ok(ctx, 201, { name: label.name, color: label.color, description: label.description });
    return true;
  }

  // /api/v3/repos/{o}/{r}/issues — create / list
  if (tail.length === 1 && tail[0] === 'issues') {
    if (method === 'POST') {
      const parsed = bodyObj(ctx);
      if (!parsed.ok) {
        badBody(ctx);
        return true;
      }
      const body = parsed.value;
      if (typeof body.title !== 'string' || body.title.length === 0) {
        err(ctx, 422, 'Missing title');
        return true;
      }
      const labelsRaw = body.labels;
      const labels: string[] = Array.isArray(labelsRaw)
        ? labelsRaw.filter((l): l is string => typeof l === 'string')
        : [];
      const issue = store.createIssue(repo, {
        title: body.title,
        body: typeof body.body === 'string' ? body.body : '',
        labels,
      });
      if ('error' in issue) {
        err(ctx, 422, `Unknown label: ${issue.label}`);
        return true;
      }
      stampNew(ctx, issueTimes, issue);
      ok(ctx, 201, issueJson(ctx, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? undefined;
      const sort = ctx.query.get('sort') ?? undefined;
      const direction = ctx.query.get('direction') ?? undefined;
      const all = store.listIssues(repo, { state, sort, direction });
      const { perPage, page } = pageParams(ctx);
      const link = linkHeader(
        ctx,
        `/api/v3/repos/${repoOwner}/${repoName}/issues`,
        linkExtra(ctx, ['state', 'sort', 'direction']),
        perPage,
        page,
        all.length,
      );
      ok(ctx, 200, paginate(all, perPage, page).map((i) => issueJson(ctx, repo, i)), link === null ? {} : { link });
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{o}/{r}/issues/{n} and .../issues/{n}/comments
  if (tail.length >= 2 && tail[0] === 'issues') {
    const n = Number(tail[1]);
    if (!Number.isInteger(n) || n <= 0) {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const issue = store.getIssue(repo, n);
    if (tail.length === 2) {
      if (issue === undefined) {
        err(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        ok(ctx, 200, issueJson(ctx, repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = bodyObj(ctx);
        if (!parsed.ok) {
          badBody(ctx);
          return true;
        }
        const patch: { state?: string; title?: string; body?: string } = {};
        if (typeof parsed.value.state === 'string') patch.state = parsed.value.state;
        if (typeof parsed.value.title === 'string') patch.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') patch.body = parsed.value.body;
        const updated = store.patchIssue(repo, n, patch);
        if (updated === null) {
          err(ctx, 404, 'Not Found');
          return true;
        }
        const times = issueTimes.get(updated);
        if (times !== undefined) times.updatedAt = store.nowIso();
        ok(ctx, 200, issueJson(ctx, repo, updated));
        return true;
      }
      err(ctx, 404, 'Not Found');
      return true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) {
        err(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'POST') {
        const parsed = bodyObj(ctx);
        if (!parsed.ok) {
          badBody(ctx);
          return true;
        }
        if (typeof parsed.value.body !== 'string' || parsed.value.body.length === 0) {
          err(ctx, 422, 'Missing comment body');
          return true;
        }
        const comment = store.addComment(repo, n, parsed.value.body);
        if (comment === null) {
          err(ctx, 404, 'Not Found');
          return true;
        }
        stampNew(ctx, commentTimes, comment);
        ok(ctx, 201, commentJson(ctx, repo, comment));
        return true;
      }
      if (method === 'GET') {
        ok(ctx, 200, store.listComments(repo, n).map((c) => commentJson(ctx, repo, c)));
        return true;
      }
      err(ctx, 404, 'Not Found');
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{o}/{r}/pulls — create / list
  if (tail.length === 1 && tail[0] === 'pulls') {
    if (method === 'POST') {
      const parsed = bodyObj(ctx);
      if (!parsed.ok) {
        badBody(ctx);
        return true;
      }
      const body = parsed.value;
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const pull = store.createPull(repo, {
        head,
        base,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
      });
      if ('error' in pull) {
        err(ctx, 422, pull.error === 'bad-head' ? 'Unknown head ref' : 'Unknown base ref');
        return true;
      }
      stampNew(ctx, pullTimes, pull);
      ok(ctx, 201, pullJson(ctx, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? undefined;
      const all = store.listPulls(repo, state);
      const { perPage, page } = pageParams(ctx);
      const link = linkHeader(
        ctx,
        `/api/v3/repos/${repoOwner}/${repoName}/pulls`,
        linkExtra(ctx, ['state']),
        perPage,
        page,
        all.length,
      );
      ok(ctx, 200, paginate(all, perPage, page).map((p) => pullJson(ctx, repo, p)), link === null ? {} : { link });
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{o}/{r}/pulls/{n}[ /files | /merge ]
  if (tail.length >= 2 && tail[0] === 'pulls') {
    const n = Number(tail[1]);
    if (!Number.isInteger(n) || n <= 0) {
      err(ctx, 404, 'Not Found');
      return true;
    }
    const pull = store.getPull(repo, n);
    if (tail.length === 2) {
      if (pull === undefined || method !== 'GET') {
        err(ctx, 404, 'Not Found');
        return true;
      }
      ok(ctx, 200, pullJson(ctx, repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (pull === undefined || method !== 'GET') {
        err(ctx, 404, 'Not Found');
        return true;
      }
      ok(ctx, 200, store.pullFiles(repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (pull === undefined) {
        err(ctx, 404, 'Not Found');
        return true;
      }
      if (method !== 'PUT') {
        err(ctx, 404, 'Not Found');
        return true;
      }
      let mergeMethod = 'merge';
      if (ctx.body.length > 0) {
        const parsed = bodyObj(ctx);
        if (!parsed.ok) {
          badBody(ctx);
          return true;
        }
        const m = parsed.value.merge_method;
        if (m === 'squash' || m === 'merge' || m === 'rebase') mergeMethod = m;
      }
      const result = store.mergePull(repo, pull, mergeMethod);
      if ('error' in result) {
        err(ctx, 405, result.error === 'conflict' ? 'Merge conflict' : 'Pull request is not open');
        return true;
      }
      const times = pullTimes.get(pull);
      if (times !== undefined) times.updatedAt = pull.mergedAt ?? times.updatedAt;
      ok(ctx, 200, { merged: true, sha: result.sha, message: result.message });
      return true;
    }
    err(ctx, 404, 'Not Found');
    return true;
  }

  err(ctx, 404, 'Not Found');
  return true;
}
