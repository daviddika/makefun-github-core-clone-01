// mcp.ts — Model Context Protocol (streamable HTTP) layer for the forge.
// POST /mcp only. Stateless: no sessions, no handshake required (modern
// server/discover era), with the legacy initialize era supported as well.
// Node 22 stdlib only; deterministic (no Date.now / Math.random).

import { sendJson, parseJsonBody } from './http.ts';
import type { Ctx } from './http.ts';
import type { Repo, Issue, Pull } from './store.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS: string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

// The tools array is built once at module load and reused verbatim on every
// tools/list call, so it is byte-identical across calls.
interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, {
    'content-length': '0',
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end();
}

function sendResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx.res, 200, { jsonrpc: '2.0', id, result }, ctx.requestId);
}

function sendRpcError(ctx: Ctx, id: unknown, code: number, message: string): void {
  sendJson(ctx.res, 200, { jsonrpc: '2.0', id, error: { code, message } }, ctx.requestId);
}

/** Pick the first defined (non-null) value among a canonical name and aliases. */
function pickArg(
  args: Record<string, unknown>,
  name: string,
  aliases: string[],
): unknown {
  if (args[name] !== undefined && args[name] !== null) return args[name];
  for (const alias of aliases) {
    if (args[alias] !== undefined && args[alias] !== null) return args[alias];
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (typeof value === 'number' && !Number.isFinite(value)) return true;
  return false;
}

function toolErrorResult(message: string): Record<string, unknown> {
  const payload = { error: message };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function toolOkResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function handleToolsCall(ctx: Ctx, id: unknown, params: Record<string, unknown>): void {
  const name = asString(params['name']);
  // params.arguments is the canonical carrier; if it is absent, fall back to
  // the remaining params fields (minus name/_meta) so a flat call still works.
  let args: Record<string, unknown> = {};
  if (isRecord(params['arguments'])) {
    args = params['arguments'];
  } else {
    for (const [key, value] of Object.entries(params)) {
      if (key !== 'name' && key !== '_meta') args[key] = value;
    }
  }

  if (name === undefined) {
    // No tool name at all (e.g. params missing entirely): the missing-args
    // path, not a JSON-RPC error — arguments are treated as {}.
    sendResult(ctx, id, toolErrorResult('missing required argument: name'));
    return;
  }

  // Required arguments per tool, with the canonical name reported on failure.
  // Aliases are accepted defensively for each canonical name.
  const required: Record<string, string[]> = {
    create_repo: ['name'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  const aliases: Record<string, string[]> = {
    name: ['repository'],
    repo: ['repository', 'repo_name'],
    title: ['issue_title', 'pr_title'],
    body: ['description', 'content'],
    head: ['head_ref'],
    base: ['base_ref'],
    pull_number: ['number', 'pr_number'],
    owner: ['owner_name'],
  };

  const requiredForTool = required[name];
  if (requiredForTool === undefined) {
    sendRpcError(ctx, id, -32602, `Unknown tool: ${name}`);
    return;
  }

  const values: Record<string, unknown> = {};
  for (const reqName of requiredForTool) {
    const value = pickArg(args, reqName, aliases[reqName] ?? []);
    if (isMissing(value)) {
      sendResult(ctx, id, toolErrorResult(`missing required argument: ${reqName}`));
      return;
    }
    values[reqName] = value;
  }
  // Optional arguments, also alias-aware.
  for (const optName of ['description', 'private', 'body', 'state', 'owner', 'repo']) {
    if (values[optName] === undefined) {
      const value = pickArg(args, optName, aliases[optName] ?? []);
      if (value !== undefined) values[optName] = value;
    }
  }
  // create_repo's description is canonical (not a body alias); body alias for
  // issues/PRs is handled above via the same pick, but a stray `body` on
  // create_repo must not clobber description, and vice versa.
  if (name === 'create_repo' && values['description'] === undefined) {
    const desc = pickArg(args, 'description', []);
    if (desc !== undefined) values['description'] = desc;
  }

  const store = ctx.store;
  const owner = asString(values['owner']) ?? '';
  const repoName = asString(values['repo']) ?? asString(values['name']) ?? '';

  if (name === 'create_repo') {
    const repoNameArg = asString(values['name']) as string;
    const description = asString(values['description']) ?? '';
    const isPrivate = values['private'] === true;
    const created = store.createRepo(repoNameArg, description, isPrivate);
    if (created === null) {
      sendResult(ctx, id, toolErrorResult('repository already exists'));
      return;
    }
    sendResult(ctx, id, toolOkResult(repoView(created)));
    return;
  }

  // Every remaining tool needs an existing repo.
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendResult(ctx, id, toolErrorResult(`repository not found: ${owner}/${repoName}`));
    return;
  }

  if (name === 'get_repo') {
    sendResult(ctx, id, toolOkResult(repoView(repo)));
    return;
  }

  if (name === 'create_issue') {
    const title = asString(values['title']) as string;
    const body = asString(values['body']) ?? '';
    const created = store.createIssue(repo, { title, body, labels: [] });
    if (isRecord(created) && created['error'] !== undefined) {
      sendResult(ctx, id, toolErrorResult(`could not create issue: ${String(created['error'])}`));
      return;
    }
    sendResult(ctx, id, toolOkResult(issueView(created as Issue)));
    return;
  }

  if (name === 'list_issues') {
    const state = asString(values['state']);
    const issues = store.listIssues(repo, { state: state ?? 'open' });
    const out = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body,
    }));
    sendResult(ctx, id, toolOkResult(out));
    return;
  }

  if (name === 'create_pull_request') {
    const title = asString(values['title']) as string;
    const body = asString(values['body']) ?? '';
    const head = asString(values['head']) as string;
    const base = asString(values['base']) as string;
    const created = store.createPull(repo, { head, base, title, body });
    if (isRecord(created) && created['error'] !== undefined) {
      const err = created['error'];
      if (err === 'bad-head') {
        sendResult(ctx, id, toolErrorResult(`invalid head ref: ${head}`));
      } else {
        sendResult(ctx, id, toolErrorResult(`invalid base ref: ${base}`));
      }
      return;
    }
    const pull = created as Pull;
    sendResult(
      ctx,
      id,
      toolOkResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: 'open',
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
      }),
    );
    return;
  }

  if (name === 'merge_pull_request') {
    const pullNumber = asNumber(values['pull_number']) as number;
    const pull = store.getPull(repo, pullNumber);
    if (pull === undefined) {
      sendResult(ctx, id, toolErrorResult(`pull request not found: ${pullNumber}`));
      return;
    }
    const merged = store.mergePull(repo, pull, 'squash');
    if (isRecord(merged) && merged['error'] !== undefined) {
      if (merged['error'] === 'conflict') {
        sendResult(ctx, id, toolErrorResult('merge conflict'));
      } else {
        sendResult(ctx, id, toolErrorResult('pull request is not open'));
      }
      return;
    }
    const result = merged as { sha: string; message: string };
    sendResult(
      ctx,
      id,
      toolOkResult({ number: pull.number, merged: true, state: 'closed', sha: result.sha }),
    );
    return;
  }
}

export async function handleMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method !== 'POST' && ctx.method !== 'DELETE') return false;

  // Auth applies to every /mcp request, both eras and every method.
  if (!ctx.authed) {
    sendJson(
      ctx.res,
      401,
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } },
      ctx.requestId,
    );
    return true;
  }

  // Legacy close: 200 with an empty body.
  if (ctx.method === 'DELETE') {
    sendEmpty(ctx, 200);
    return true;
  }

  // POST /mcp: a single JSON-RPC 2.0 request. Invalid JSON is a parse error.
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendJson(
      ctx.res,
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      ctx.requestId,
    );
    return true;
  }

  const req = parsed.value;
  if (!isRecord(req)) {
    sendJson(
      ctx.res,
      200,
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
      ctx.requestId,
    );
    return true;
  }

  const id: unknown = req['id'];
  const method = req['method'];
  const params: Record<string, unknown> = isRecord(req['params']) ? req['params'] : {};

  // Notifications carry no id and need no response body.
  if (id === undefined) {
    sendEmpty(ctx, 202);
    return true;
  }

  if (typeof method !== 'string' || method === '') {
    sendRpcError(ctx, id, -32600, 'Invalid Request');
    return true;
  }

  if (method === 'notifications/initialized') {
    sendEmpty(ctx, 202);
    return true;
  }

  if (method === 'server/discover') {
    sendResult(ctx, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'initialize') {
    const offered = params['protocolVersion'];
    sendResult(ctx, id, {
      protocolVersion: typeof offered === 'string' ? offered : '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'tools/list') {
    sendResult(ctx, id, { tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    handleToolsCall(ctx, id, params);
    return true;
  }

  sendRpcError(ctx, id, -32601, 'Method not found');
  return true;
}
