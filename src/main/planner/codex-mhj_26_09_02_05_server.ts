import http from 'node:http';
import { logInfo, logWarn } from '../logger.js';
import {
  MAX_PLANNER_BODY_BYTES,
  MAX_PLANNER_RESPONSE_BYTES,
  PLANNER_HOST,
  PLANNER_ORIGINS,
  PLANNER_PORT,
  type PlannerErrorBody,
  type PlannerStatus,
  type PlanWriteInput,
  type RepoReadInput,
  type RepoSearchInput,
  type RepoTreeInput
} from './codex-mhj_26_09_02_01_types.js';
import { planWrite, plannerStatus, repoRead, repoSearch, repoTree } from './codex-mhj_26_09_02_03_repository.js';
import { PLANNER_HTML, PLANNER_SCRIPT } from './codex-mhj_26_09_02_04_page.js';
import { FULL_HTML, FULL_SCRIPT } from '../full/codex-mhj_26_09_02_02_page.js';
import {
  FullRequestError,
  FullUnknownToolError,
  MAX_FULL_BODY_BYTES,
  MAX_FULL_RESPONSE_BYTES,
  fullTools,
  invokeFullTool
} from '../full/codex-mhj_26_09_02_01_adapter.js';

const SHUTDOWN_DEADLINE_MS = 15_000;
let server: http.Server | null = null;
let startRequest: Promise<number | null> | null = null;
let shutdownRequested = false;

function originOf(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  if (Array.isArray(origin)) return origin[0] ?? null;
  return origin;
}

function writeHeaders(res: http.ServerResponse, origin: string | null, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  if (origin !== null && PLANNER_ORIGINS.includes(origin as (typeof PLANNER_ORIGINS)[number])) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function jsonWithLimit(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  origin: string | null,
  maxBytes: number,
  tooLargeMessage: string
): void {
  writeHeaders(res, origin, 'application/json; charset=utf-8');
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'response_too_large', message: tooLargeMessage } satisfies PlannerErrorBody));
    return;
  }
  res.statusCode = status;
  res.end(serialized);
}

function json(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void {
  jsonWithLimit(res, status, body, origin, MAX_PLANNER_RESPONSE_BYTES, 'Planner response is too large');
}

function fullJson(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void {
  jsonWithLimit(res, status, body, origin, MAX_FULL_RESPONSE_BYTES, 'Full response is too large');
}

function errorBody(error: unknown): PlannerErrorBody {
  if (error instanceof Error) return { error: error.name || 'planner_error', message: error.message };
  return { error: 'planner_error', message: 'Planner request failed' };
}

function statusFor(error: unknown): number {
  if (error instanceof SyntaxError) return 400;
  if (error instanceof Error && error.name === 'PlannerValidationError') return 400;
  if (error instanceof Error && error.name === 'SandboxError') return 403;
  return 500;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(error);
    };
    req.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += data.length;
      if (total > maxBytes) fail(new Error('payload_too_large'));
      else chunks.push(data);
    });
    req.on('error', (error) => fail(error));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new SyntaxError('invalid_json'));
      }
    });
  });
}

function allowedOrigin(req: http.IncomingMessage): string | null {
  const origin = originOf(req);
  return origin === null || PLANNER_ORIGINS.includes(origin as (typeof PLANNER_ORIGINS)[number]) ? origin : null;
}

function originRejected(req: http.IncomingMessage): boolean {
  const origin = originOf(req);
  return origin !== null && !PLANNER_ORIGINS.includes(origin as (typeof PLANNER_ORIGINS)[number]);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const origin = allowedOrigin(req);
  if (originRejected(req)) {
    json(res, 403, { error: 'origin_not_allowed', message: 'Only the local Planner page may call this server' }, null);
    return;
  }
  const url = new URL(req.url ?? '/', `http://${PLANNER_HOST}:${PLANNER_PORT}`);
  if (req.method === 'OPTIONS') {
    writeHeaders(res, origin, 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/planner') {
    writeHeaders(res, null, 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.statusCode = 200;
    res.end(PLANNER_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/planner.js') {
    writeHeaders(res, null, 'text/javascript; charset=utf-8');
    res.statusCode = 200;
    res.end(PLANNER_SCRIPT);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/full') {
    writeHeaders(res, null, 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.statusCode = 200;
    res.end(FULL_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/full.js') {
    writeHeaders(res, null, 'text/javascript; charset=utf-8');
    res.statusCode = 200;
    res.end(FULL_SCRIPT);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/full/tools') {
    try {
      fullJson(res, 200, fullTools(url.searchParams.get('pageId')), origin);
    } catch (error) {
      const status = error instanceof FullRequestError ? 400 : 500;
      fullJson(res, status, { error: 'full_request_failed', message: error instanceof FullRequestError ? error.message : 'Full tools request failed' }, origin);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/full/call') {
    // A browser call must carry the local page origin. This keeps the mutating adapter from
    // becoming a permissive localhost JSON endpoint while retaining Planner's existing rules.
    if (origin === null) {
      fullJson(res, 403, { error: 'origin_required', message: 'Full tool calls require the local page origin' }, null);
      req.resume();
      return;
    }
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FULL_BODY_BYTES) {
      fullJson(res, 413, { error: 'payload_too_large', message: 'Full request body is too large' }, origin);
      req.resume();
      return;
    }
    try {
      const body = await readBody(req, MAX_FULL_BODY_BYTES);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new FullRequestError('Full request must be a JSON object');
      const input = body as Record<string, unknown>;
      const result = await invokeFullTool({
        pageId: input.pageId as string,
        name: input.name as string,
        arguments: input.arguments
      });
      fullJson(res, 200, { result }, origin);
    } catch (error) {
      if (error instanceof Error && error.message === 'payload_too_large') {
        fullJson(res, 413, { error: 'payload_too_large', message: 'Full request body is too large' }, origin);
        return;
      }
      const status = error instanceof FullUnknownToolError ? 404 : error instanceof FullRequestError ? 400 : 500;
      const message = error instanceof FullRequestError || error instanceof FullUnknownToolError ? error.message : 'Full tool request failed';
      fullJson(res, status, { error: error instanceof FullUnknownToolError ? 'unknown_tool' : 'full_request_failed', message }, origin);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/planner/status') {
    const requestedRoot = url.searchParams.get('root');
    const status = await plannerStatus(requestedRoot);
    const response: PlannerStatus = { running: server !== null, port: PLANNER_PORT, ...status };
    json(res, 200, response, origin);
    return;
  }
  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    '/api/planner/tree': (body) => repoTree({
      rootName: body.rootName as string,
      path: (body.path as string | undefined) ?? '',
      depth: (body.depth as number | undefined) ?? 3
    } satisfies RepoTreeInput),
    '/api/planner/search': (body) => repoSearch({
      rootName: body.rootName as string,
      query: body.query as string,
      path: (body.path as string | undefined) ?? '',
      mode: (body.mode as RepoSearchInput['mode'] | undefined) ?? 'content',
      maxResults: (body.maxResults as number | undefined) ?? 50,
      include: (body.include as string | null | undefined) ?? null,
      caseSensitive: body.caseSensitive === true
    } satisfies RepoSearchInput),
    '/api/planner/read': (body) => repoRead({
      rootName: body.rootName as string,
      path: body.path as string,
      startLine: (body.startLine as number | null | undefined) ?? null,
      endLine: (body.endLine as number | null | undefined) ?? null,
      maxBytes: (body.maxBytes as number | undefined) ?? 256 * 1024
    } satisfies RepoReadInput),
    '/api/planner/write': (body) => planWrite({
      rootName: body.rootName as string,
      taskId: body.taskId as string,
      documentType: body.documentType as PlanWriteInput['documentType'],
      blockId: (body.blockId as string | null | undefined) ?? null,
      content: body.content as string
    } satisfies PlanWriteInput)
  };
  const route = routes[url.pathname];
  if (req.method !== 'POST' || !route) {
    json(res, 404, { error: 'not_found', message: 'Planner route not found' }, origin);
    return;
  }
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PLANNER_BODY_BYTES) {
    json(res, 413, { error: 'payload_too_large', message: 'Planner request body is too large' }, origin);
    req.resume();
    return;
  }
  try {
    const body = await readBody(req, MAX_PLANNER_BODY_BYTES);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('invalid_json');
    const result = await route(body as Record<string, unknown>);
    json(res, 200, result, origin);
  } catch (error) {
    if (error instanceof Error && error.message === 'payload_too_large') {
      json(res, 413, { error: 'payload_too_large', message: 'Planner request body is too large' }, origin);
      return;
    }
    json(res, statusFor(error), errorBody(error), origin);
  }
}

/** Request listener used by the fixed loopback server and by bounded HTTP tests. */
export function plannerRequestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  void handle(req, res).catch((error) => {
    if (!res.headersSent) json(res, 500, errorBody(error), originOf(req));
  });
}

export function startPlannerServer(): Promise<number | null> {
  if (server?.listening) return Promise.resolve(PLANNER_PORT);
  if (shutdownRequested) return Promise.resolve(null);
  if (startRequest) return startRequest;
  startRequest = new Promise<number | null>((resolve) => {
    const instance = http.createServer(plannerRequestHandler);
    instance.headersTimeout = 30_000;
    instance.requestTimeout = 30_000;
    instance.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') logWarn(`planner port ${PLANNER_PORT} is already in use`);
      else logWarn(`planner server could not start: ${error.message}`);
      instance.close();
      resolve(null);
    });
    instance.listen(PLANNER_PORT, PLANNER_HOST, () => {
      if (shutdownRequested) {
        instance.close();
        resolve(null);
        return;
      }
      server = instance;
      logInfo(`planner listening on ${PLANNER_HOST}:${PLANNER_PORT}`);
      resolve(PLANNER_PORT);
    });
  }).finally(() => {
    startRequest = null;
  });
  return startRequest;
}

export async function shutdownPlannerServer(): Promise<void> {
  shutdownRequested = true;
  const pending = startRequest;
  if (pending) await pending.catch(() => null);
  const instance = server;
  server = null;
  if (!instance) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const force = setTimeout(() => {
      if (settled) return;
      instance.closeAllConnections();
      settled = true;
      resolve();
    }, SHUTDOWN_DEADLINE_MS);
    force.unref?.();
    instance.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      resolve();
    });
  });
  logInfo('planner stopped');
}

export function plannerServerPort(): number | null {
  return server?.listening ? PLANNER_PORT : null;
}
