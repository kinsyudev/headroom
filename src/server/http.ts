/**
 * Guard, every route: Host must be exactly 127.0.0.1:<port> or localhost:<port>, which stops DNS
 * rebinding. POST also needs `X-CPA-Deck: 1` and `Content-Type: application/json`; a cross-origin
 * page can't send either without a preflight, and nothing here answers preflights or sends CORS
 * headers.
 */
import { ZodError } from 'zod';
import { ACTIONS, type ActionInput, type ActionKind } from '../shared/actions';
import { DECK_ERROR_STATUS, DeckError } from '../shared/errors';
import type { Snapshot } from '../shared/domain';
import { HISTORY_RANGES, type HistoryRange, type HistoryView } from '../shared/history';
import type { Handler, HandlerCtx, Handlers } from './handlers';

export interface Asset {
  readonly body: ArrayBuffer;
  readonly type: string;
}

export interface HttpDeps {
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly assets: ReadonlyMap<string, Asset>;
  readonly snapshot: () => Snapshot;
  readonly history: (range: HistoryRange) => HistoryView;
  readonly handlers: Handlers;
  readonly ctx: HandlerCtx;
}

const BASE_HEADERS = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export const BUN_MAX_IDLE_TIMEOUT_S = 255;

export function serve(deps: HttpDeps): { readonly url: string; stop(): Promise<void> } {
  const server = Bun.serve({
    hostname: deps.hostname,
    port: deps.port,
    idleTimeout: BUN_MAX_IDLE_TIMEOUT_S,
    fetch: (req: Request): Promise<Response> => route(req, deps, server.port!).catch(errorResponse),
  });
  return { url: `http://${deps.hostname}:${server.port}`, stop: () => server.stop(true) };
}

async function route(req: Request, deps: HttpDeps, port: number): Promise<Response> {
  const url = new URL(req.url);
  const blocked = guard(req, { port, mutate: req.method !== 'GET' && req.method !== 'HEAD' });
  if (blocked) return blocked;
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/api/snapshot') return json(deps.snapshot());
    if (url.pathname === '/api/history') return json(deps.history(parseRange(url.searchParams.get('range'))));
    const asset = deps.assets.get(url.pathname);
    if (asset) return new Response(asset.body, { headers: { ...BASE_HEADERS, 'Content-Type': asset.type } });
    return json({ error: { code: 'not_found', message: url.pathname } }, 404);
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    const body: unknown = await req.json().catch(() => {
      throw new DeckError('invalid', 'body is not JSON');
    });
    const { kind, input } = parseActBody(body);
    return json(await dispatch(kind, input, deps.handlers, deps.ctx));
  }
  return json({ error: { code: 'method_not_allowed', message: req.method } }, 405);
}

function dispatch<K extends ActionKind>(kind: K, raw: unknown, handlers: Handlers, ctx: HandlerCtx): Promise<unknown> {
  const input = ACTIONS[kind].input.parse(raw) as ActionInput<K>;
  return (handlers[kind] as Handler<K>)(input, ctx);
}

export function guard(req: Request, opts: { readonly port: number; readonly mutate: boolean }): Response | null {
  const host = req.headers.get('host');
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) {
    return json({ error: { code: 'forbidden', message: 'host not allowed' } }, 421);
  }
  if (!opts.mutate) return null;
  if (req.headers.get('x-cpa-deck') !== '1') return json({ error: { code: 'forbidden', message: 'missing X-CPA-Deck header' } }, 403);
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: { code: 'forbidden', message: 'Content-Type must be application/json' } }, 415);
  }
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== `http://${host}`) return json({ error: { code: 'forbidden', message: 'cross-origin request' } }, 403);
  return null;
}

export function parseActBody(body: unknown): { kind: ActionKind; input: unknown } {
  const b = body as { kind?: unknown; input?: unknown } | null;
  if (typeof b !== 'object' || b === null || typeof b.kind !== 'string' || !Object.hasOwn(ACTIONS, b.kind)) {
    throw new DeckError('invalid', 'unknown action');
  }
  return { kind: b.kind as ActionKind, input: b.input ?? {} };
}

export function parseRange(q: string | null): HistoryRange {
  if (q === null) return '24h';
  if ((HISTORY_RANGES as readonly string[]).includes(q)) return q as HistoryRange;
  throw new DeckError('invalid', `range must be one of ${HISTORY_RANGES.join(', ')}`);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof DeckError) return json({ error: { code: e.code, message: e.message } }, DECK_ERROR_STATUS[e.code]);
  if (e instanceof ZodError) return json({ error: { code: 'invalid', message: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } }, 400);
  console.error('cpa-deck internal error:', e instanceof Error ? e.message : String(e));
  return json({ error: { code: 'internal', message: 'internal error' } }, 500);
}

export async function buildUi(entry: string): Promise<Map<string, Asset>> {
  const r = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
  if (!r.success) throw new AggregateError(r.logs, 'UI build failed');
  const assets = new Map<string, Asset>();
  for (const o of r.outputs) {
    const path = o.path.replace(/^\.\//, '/');
    assets.set(path.endsWith('.html') ? '/' : path, { body: await o.arrayBuffer(), type: o.type });
  }
  return assets;
}
