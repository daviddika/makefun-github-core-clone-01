// app.ts — the forge's HTTP server: routing, auth, body reading, JSON 404.
// The surface modules (rest, graphql, mcp, githttp) each own their routes; this file
// only dispatches. main.ts (lifecycle) is unchanged from the starter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';
import {
  bearerToken,
  nextRequestId,
  readBody,
  sendJson,
  type Ctx,
} from './http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function isGitPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const requestId = nextRequestId();
      try {
        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        const body = await readBody(req);
        const token = bearerToken(req);
        const authed = expectedToken !== '' && token !== null && token === expectedToken;
        let query: URLSearchParams;
        try {
          query = new URL(req.url ?? '/', 'http://entry').searchParams;
        } catch {
          query = new URLSearchParams();
        }
        const ctx: Ctx = {
          store,
          req,
          res,
          method,
          path,
          segments: segmentsOf(path),
          query,
          body,
          authed,
          requestId,
        };

        if (isGitPath(path)) {
          if (await handleGit(ctx)) return;
        } else if (method === 'POST' && path === '/api/graphql') {
          if (await handleGraphQL(ctx)) return;
        } else if (path === '/mcp') {
          if (await handleMcp(ctx)) return;
        } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(ctx)) return;
        }

        // Anything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        // Never leak a stack or crash on a bad request: JSON 500.
        if (!res.headersSent) {
          try {
            const text = `${JSON.stringify({ message: 'Internal Server Error' })}\n`;
            res.writeHead(500, {
              'content-type': JSON_TYPE,
              'content-length': Buffer.byteLength(text),
              'x-github-request-id': requestId,
            });
            res.end(text);
          } catch {
            // The socket is gone; nothing more to do.
          }
        }
        process.stderr.write(`[app] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
