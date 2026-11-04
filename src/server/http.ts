/**
 * The HTTP shell: Bun.serve, the request guard, five API routes, and the SSE hub.
 * It stays thin. It parses, guards, and dispatches. Every decision lives in a module it calls.
 *
 * Guard (all routes):
 *   Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`. A DNS-rebinding attacker's page
 *   reaches us with Host `evil.example:<port>` and gets 421 before any route runs.
 * Guard (POST /api/act, in addition):
 *   - Origin is present and is http://127.0.0.1:<port> or http://localhost:<port>
 *   - Sec-Fetch-Site, when the browser sends it, is 'same-origin'
 *   - Content-Type is application/json. That forces a CORS preflight for any cross-site fetch, and we
 *     answer no preflight (OPTIONS → 405, and no Access-Control-* header anywhere).
 *   - X-Deck-Csrf equals the per-process secret. Only a same-origin page can read it from /api/session.
 * Each layer alone stops a cross-site form or fetch. Together they cover old browsers, rebinding, and extensions.
 *
 * SSE: Bun.serve's default idleTimeout is 10 s, which would cut /api/stream. Call server.timeout(req, 0)
 * for that request and send a ':ka' comment every 5 s anyway.
 */
import { ACTIONS, DECK_ERROR_STATUS, DeckError, type ActionKind } from '../shared/actions';
import type { Instant, Snapshot } from '../shared/domain';
import type { HistoryRange } from '../shared/history';
import type { Claims } from './claims';
import type { Cpa } from './cpa';
import type { Handlers, HandlerCtx } from './handlers';
import type { Keeper } from './keeper';
import type { OAuthFlows } from './oauth';
import type { Observer } from './observer';

export interface HttpDeps {
  readonly port: number;
  /** The HTML import: `import app from '../ui/index.html'`. Bun bundles the TSX behind it. */
  readonly app: unknown;
  readonly cpa: Cpa;
  readonly observer: Observer;
  readonly claims: Claims;
  readonly oauth: OAuthFlows;
  readonly keeper: Keeper;
  readonly handlers: Handlers;
  readonly now: () => Instant;
}

/**
 * Binds 127.0.0.1:<port>. Call it FIRST in main.ts. Port acquisition doubles as the single-instance
 * lock: a second deck process fails here before it sends anything to CPA.
 *
 * Routes:
 *   GET  /               deps.app
 *   GET  /api/session    { csrf }
 *   GET  /api/snapshot   Snapshot
 *   GET  /api/stream     text/event-stream: `event: snapshot` + JSON on every hub change
 *   GET  /api/history    ?range=24h|7d|30d → keeper.history(range)
 *   POST /api/act        { kind, input } → handlers[kind](ACTIONS[kind].input.parse(input), ctx)
 *   *                    404
 * Errors: DeckError → { error: { code, message } } with DECK_ERROR_STATUS[code]; ZodError → 400 invalid;
 *         anything else → 500 { error: { code: 'internal' } }, and the message is logged without bodies.
 */
export interface DeckServer {
  /** Until called, POST /api/act answers 503 link_down. main.ts calls it after claims.recover(). */
  acceptActions(): void;
  stop(): Promise<void>;
}

export function serve(deps: HttpDeps): DeckServer {
  void ACTIONS;
  void DECK_ERROR_STATUS;
  void DeckError;
  throw new Error('not implemented');
}

/** Returns a Response to send instead of routing, or null to continue. Pure apart from reading the request. */
export function guard(req: Request, opts: { port: number; mutate: boolean }): Response | null {
  throw new Error('not implemented');
}

/** The request body for /api/act, before per-kind parsing. */
export function parseActBody(body: unknown): { kind: ActionKind; input: unknown } {
  // TODO: body is an object with a string `kind` that's a key of ACTIONS → else DeckError('invalid')
  throw new Error('not implemented');
}

/**
 * Builds the Snapshot at the read boundary from each owner's part. No owner writes another's part,
 * so there's nothing to lock. The hub subscribes to every owner's onChange, debounces 100 ms, bumps
 * `version`, and pushes the new Snapshot to every SSE client.
 */
export interface Hub {
  snapshot(): Snapshot;
  subscribe(send: (s: Snapshot) => void): () => void;
}

export function createHub(deps: Pick<HttpDeps, 'cpa' | 'observer' | 'claims' | 'oauth' | 'now'>): Hub {
  // TODO: snapshot = { version, generatedAt: now(), link: cpa.link(), ...observer.state(), claims: claims.list(), flows: oauth.list() }
  throw new Error('not implemented');
}

export function handlerCtx(deps: HttpDeps): HandlerCtx {
  throw new Error('not implemented');
}

/** `?range=` → HistoryRange; anything else → DeckError('invalid'). */
export function parseRange(q: string | null): HistoryRange {
  throw new Error('not implemented');
}
