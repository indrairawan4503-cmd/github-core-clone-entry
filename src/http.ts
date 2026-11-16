// The HTTP layer: one Node server, four surfaces.
//
//   GET  /healthz                                  the boot probe
//   /{owner}/{repo}.git/...                        git smart HTTP (no auth check)
//   POST /api/graphql                              GraphQL
//   POST /mcp                                      MCP
//   /api/v3/...                                    REST v3
//
// REST, GraphQL and MCP all require `Authorization: Bearer <token>` where
// the token is MAKEFUN_SHOP_TOKEN. When the variable is unset (a local
// run), any non-empty bearer token is accepted. Every JSON reply carries a
// non-empty X-GitHub-Request-Id, handed out in arrival order.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQLBody } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitserver.ts';
import { trialClockFromEnv } from './clock.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;

export interface ForgeOptions {
  /** The bearer token the API surfaces require; null accepts any non-empty token. */
  token: string | null;
}

export function createForge(env: NodeJS.ProcessEnv): Server {
  const store = new Store(trialClockFromEnv(env));
  const configuredToken = env.MAKEFUN_SHOP_TOKEN ?? '';
  const options: ForgeOptions = { token: configuredToken === '' ? null : configuredToken };
  return createServer((req, res) => {
    void handleRequest(store, options, req, res).catch((error: unknown) => {
      try {
        sendJson(res, 500, { message: error instanceof Error ? error.message : 'internal error' }, store);
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, store: Store, extraHeaders: Record<string, string> = {}): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': bytes.length,
    'x-github-request-id': `req-${store.requestIds.take()}`,
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // GET and HEAD never carry a body in this service; answering at once
  // saves an event-loop turn on every read.
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : (match[1] ?? null);
}

function authorized(options: ForgeOptions, req: IncomingMessage): boolean {
  const presented = bearerToken(req);
  if (presented === null || presented === '') return false;
  if (options.token === null) return true;
  return presented === options.token;
}

/** The request URL, parsed once per request. */
function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function pathOf(url: URL): string {
  return url.pathname;
}

function queryOf(url: URL): URLSearchParams {
  return url.searchParams;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(
  store: Store,
  options: ForgeOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = requestUrl(req);
  const path = pathOf(url);
  const query = queryOf(url);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, store);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs and the two services.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1] ?? '');
    const repoName = decodeSegment(gitMatch[2] ?? '');
    const suffix = gitMatch[3] ?? '';
    if (method === 'GET' && suffix === '/info/refs') {
      const service = query.get('service') ?? '';
      const answer = handleInfoRefs(store, owner, repoName, service, req.headers['git-protocol'] ?? '');
      sendBuffer(res, answer.status, answer.body, answer.contentType);
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      const body = await readBody(req);
      const answer = handleUploadPack(store, owner, repoName, body);
      sendBuffer(res, answer.status, answer.body, answer.contentType);
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      const body = await readBody(req);
      const answer = handleReceivePack(store, owner, repoName, body);
      sendBuffer(res, answer.status, answer.body, answer.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }, store);
    return;
  }

  // GraphQL and MCP both require a bearer token.
  if (path === '/api/graphql' && method === 'POST') {
    if (!authorized(options, req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, store);
      return;
    }
    const body = await readBody(req);
    const answer = handleGraphQLBody(store, body);
    sendJson(res, answer.status, answer.body, store);
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    const body = await readBody(req);
    // A body that is not JSON is a parse error before auth is considered.
    let parses = true;
    try {
      JSON.parse(body.toString('utf8'));
    } catch {
      parses = false;
    }
    if (!parses) {
      const answer = handleMcpBody(store, body);
      sendJson(res, answer.status, answer.body, store);
      return;
    }
    if (!authorized(options, req)) {
      res.writeHead(401, {
        'content-type': JSON_TYPE,
        'x-github-request-id': `req-${store.requestIds.take()}`,
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthorized' } }));
      return;
    }
    const answer = handleMcpBody(store, body);
    if (answer.body === null) {
      res.writeHead(answer.status);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body, store);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(options, req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, store);
      return;
    }
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').map(decodeSegment);
    const body = await readBody(req);
    const request: RestRequest = {
      method,
      segments,
      query,
      rawBody: body,
      host: req.headers.host ?? '127.0.0.1',
    };
    const answer = handleRest(store, request);
    if (answer.body === null) {
      res.writeHead(answer.status, {
        'content-type': JSON_TYPE,
        'x-github-request-id': `req-${store.requestIds.take()}`,
        ...(answer.headers ?? {}),
      });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body, store, answer.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, store);
}
