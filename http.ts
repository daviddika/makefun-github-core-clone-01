// http.ts — shared request context and response helpers for all surface modules.
// Every handler has the signature: (ctx: Ctx) => Promise<boolean> (true = route matched
// and response sent, false = not this module's route). Handlers send responses themselves.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** Decoded pathname, e.g. "/api/v3/repos/adaiversen/x". */
  path: string;
  /** Path split on '/', first element '' removed, each segment decodeURIComponent'd. */
  segments: string[];
  query: URLSearchParams;
  /** Raw request body (empty Buffer when none). */
  body: Buffer;
  /** True when Authorization: Bearer <MAKEFUN_SHOP_TOKEN> matched. */
  authed: boolean;
  /** Per-request id, sent as X-GitHub-Request-Id on every JSON reply. */
  requestId: string;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Send a JSON body (object/array) with the standard headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

/** Send raw bytes with an explicit content type. */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/** Parse the request body as JSON. Returns { ok: true, value } or { ok: false } on empty/invalid. */
export function parseJsonBody(ctx: Ctx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.body.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m !== null ? (m[1] as string) : null;
}

/** Read the full request body (with a 16 MiB cap; larger bodies are truncated). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}
