// The server: one shared Store, routed to REST v3, GraphQL v4, MCP and git smart HTTP.
// main.ts (the lifecycle) is untouched; this file is the server app.ts builds.
// Every response carries a non-empty X-GitHub-Request-Id. A malformed request body is a 400,
// never a crash: the server must stay up for the checks that follow.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type HttpRequest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  decodeUntilFlush,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  receivePackAdvertisement,
  uploadPackAdvertisement,
} from './gitwire.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function sendBuffer(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | null): void {
  const out: Record<string, string> = { ...headers };
  if (body !== null) out['content-length'] = String(body.length);
  res.writeHead(status, out);
  res.end(body);
}

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  sendBuffer(res, status, { 'content-type': JSON_TYPE, 'x-github-request-id': store.requestId(), ...extra }, Buffer.from(text, 'utf8'));
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function headersOf(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out.set(key.toLowerCase(), value);
    else if (Array.isArray(value) && value.length) out.set(key.toLowerCase(), value[0]);
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function authed(headers: Map<string, string>): boolean {
  const auth = headers.get('authorization');
  if (!auth) return false;
  const match = /^Bearer\s+(.+)$/.exec(auth.trim());
  if (!match || !match[1]) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  return match[1] === expected;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const rawPath = pathOf(req);
      const headers = headersOf(req);
      let pathname: string = rawPath;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        pathname = rawPath;
      }
      const url = new URL(req.url ?? '/', 'http://entry');
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(store, res, 200, { ok: true });
        return;
      }

      const body = await readBody(req);

      // GraphQL v4.
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(store, res, 405, { message: 'Method not allowed' });
          return;
        }
        if (!authed(headers)) {
          sendJson(store, res, 401, { message: 'Bad credentials' });
          return;
        }
        const result = handleGraphql(store, body);
        sendJson(store, res, result.status, result.body);
        return;
      }

      // MCP.
      if (pathname === '/mcp') {
        const result = handleMcp(store, { method, pathname, headers, body });
        if (result.body === null) {
          sendBuffer(res, result.status, { 'x-github-request-id': store.requestId(), ...result.headers }, null);
        } else {
          sendBuffer(res, result.status, { 'x-github-request-id': store.requestId(), ...result.headers }, result.body);
        }
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
      if (gitMatch) {
        const owner = gitMatch[1];
        const repoName = gitMatch[2];
        const suffix = gitMatch[3] ?? '';
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          sendJson(store, res, 404, { message: 'Not Found' });
          return;
        }
        const isV2 = headers.get('git-protocol') === 'version=2';
        try {
          if (method === 'GET' && suffix.startsWith('info/refs')) {
            const service = url.searchParams.get('service') ?? '';
            if (service === 'git-upload-pack') {
              const ad = uploadPackAdvertisement(store, repo, isV2);
              sendBuffer(res, 200, { 'content-type': ad.contentType, 'x-github-request-id': store.requestId() }, ad.body);
              return;
            }
            if (service === 'git-receive-pack') {
              const ad = receivePackAdvertisement(store, repo);
              sendBuffer(res, 200, { 'content-type': ad.contentType, 'x-github-request-id': store.requestId() }, ad.body);
              return;
            }
            sendJson(store, res, 400, { message: 'Unknown service' });
            return;
          }
          if (method === 'POST' && suffix === 'git-upload-pack') {
            if (isV2) {
              const { packets } = decodeUntilFlush(body);
              const first = packets.find((p) => p.kind === 'data');
              const command = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
              if (command === 'command=ls-refs') {
                const out = handleLsRefs(store, repo, body);
                sendBuffer(res, 200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': store.requestId() }, out);
                return;
              }
              if (command === 'command=fetch') {
                const out = handleFetchV2(store, repo, body);
                sendBuffer(res, 200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': store.requestId() }, out);
                return;
              }
              sendJson(store, res, 400, { message: 'Unknown command' });
              return;
            }
            const out = handleFetchV0(store, repo, body);
            sendBuffer(res, 200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': store.requestId() }, out);
            return;
          }
          if (method === 'POST' && suffix === 'git-receive-pack') {
            const out = handleReceivePack(store, repo, body);
            sendBuffer(res, 200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': store.requestId() }, out);
            return;
          }
        } catch (err) {
          // A malformed git body is a 400; the server stays up.
          sendJson(store, res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
          return;
        }
        sendJson(store, res, 404, { message: 'Not Found' });
        return;
      }

      // REST v3.
      if (pathname.startsWith('/api/v3')) {
        const result = handleRest(store, {
          method,
          pathname,
          search: url.searchParams,
          headers,
          body,
          baseUrl,
        });
        sendBuffer(res, result.status, { 'x-github-request-id': store.requestId(), ...result.headers }, result.body);
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(store, res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      try {
        sendJson(store, res, 500, { message: err instanceof Error ? err.message : 'Internal server error' });
      } catch {
        // The response is already gone; nothing more to do.
      }
    });
  });
}
