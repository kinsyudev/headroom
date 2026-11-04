/**
 * CPA management API client. It's the only module that talks to http://127.0.0.1:8317/v0/management,
 * and the only one that sees the management key.
 *
 * What it hides from callers:
 * - The lockout hazard. CPA bans an IP for 30 minutes after 5 failed auths, and the ban also locks
 *   out keeper. So:
 *     • no request is ever built without a ManagementKey (the type is non-empty by construction);
 *     • the first 401/403 latches LinkState 'rejected', and no further request is sent until the env
 *       file's key changes (config.watchManagementKey → setKey);
 *     • every failure is persisted (store.authFailures). If 2 or more happened in the last 30 min,
 *       the link is 'guarded' and we don't even try. That holds across restarts and leaves keeper 3
 *       of the 5 strikes.
 * - CPA's wire shapes. Each upstream JSON is parsed by a private zod schema into domain types.
 *   Wire types are never exported.
 * - Account naming. PATCH bodies need the file `name`; everyone else uses AccountId. The
 *   AccountId → name map is private and refreshed by every listAccounts().
 * - Token material. refreshToken() parses `{ ok }` only. The `auth` object never leaves send().
 *
 * What it does NOT do: never calls /usage-queue, never DELETEs auth files (test/boundaries.test.ts).
 */
import { z } from 'zod';
import type { AccountId, CpaAccount, Instant, LinkState, RoutingStrategy } from '../shared/domain';
import { DeckError } from '../shared/actions';
import type { ManagementKey } from './config';
import type { AuthFailuresTable } from './store';

export const LOCKOUT_WINDOW_MS = 30 * 60_000;
export const LOCKOUT_BUDGET = 2;

/** A request for CPA's /api-call proxy. `$TOKEN$` in header values and `data` is substituted by CPA. */
export interface UpstreamRequest {
  readonly account: AccountId;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly header: Readonly<Record<string, string>>;
  readonly data?: string;
  /** Our fetch timeout to CPA. It must exceed the upstream timeout (claims: 25 s upstream → 35 s here). */
  readonly timeoutMs: number;
}

/**
 * What came back from api-call. These are the three cases claims.ts needs to tell apart:
 * - 'answered': CPA made the call and relayed Anthropic's reply. `status` is api-call's status_code.
 * - 'not_sent': we know Anthropic was never contacted (CPA refused before proxying, or the TCP
 *   connect to CPA failed).
 * - 'unknown': the request may have left. This covers a timeout or a connection dropped after
 *   the request was written.
 */
export type UpstreamResult =
  | { readonly kind: 'answered'; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: unknown }
  | { readonly kind: 'not_sent'; readonly why: string }
  | { readonly kind: 'unknown'; readonly why: string };

export interface Cpa {
  link(): LinkState;
  onLinkChange(cb: (link: LinkState) => void): () => void;
  /** Swap in a new key from the env file. Clears a 'rejected' latch and runs one validate(), budget permitting. */
  setKey(key: ManagementKey | null): Promise<LinkState>;
  /** One GET /auth-files. It's the startup check and the only retry after a key change. */
  validate(): Promise<LinkState>;

  /** Claude OAuth accounts only (provider === 'claude'). Updates the private id → name map. */
  listAccounts(): Promise<{ readonly accounts: readonly CpaAccount[]; readonly observedAt: Instant }>;
  getStrategy(): Promise<RoutingStrategy>;

  setStrategy(strategy: RoutingStrategy): Promise<void>;
  setDisabled(account: AccountId, disabled: boolean): Promise<void>;
  setPriority(account: AccountId, priority: number): Promise<void>;
  /** CPA `POST /reset-quota`: clears CPA's local cooldown. Never contacts Anthropic. */
  clearCooldown(account: AccountId): Promise<void>;
  /** Returns only whether CPA said ok. Token material is parsed away inside. */
  refreshToken(account: AccountId): Promise<{ readonly ok: boolean }>;

  startOAuth(): Promise<{ readonly url: string; readonly state: string }>;
  oauthStatus(state: string): Promise<{ readonly kind: 'wait' } | { readonly kind: 'ok' } | { readonly kind: 'error'; readonly error: string }>;

  /** Generic upstream proxy. Never throws for upstream outcomes; it throws DeckError('link_down') only. */
  apiCall(req: UpstreamRequest): Promise<UpstreamResult>;
}

export function createCpa(opts: {
  readonly baseUrl: string;
  readonly key: ManagementKey | null;
  readonly envPath: string;
  readonly authFailures: AuthFailuresTable;
  readonly now: () => Instant;
}): Cpa {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Private transport. Every request goes through send(). Nothing else calls fetch on CPA.
// ---------------------------------------------------------------------------------------------

/**
 * TODO:
 * 1. link.kind !== 'ok' → throw DeckError('link_down'). No request is built.
 * 2. authFailures.countSince(now - LOCKOUT_WINDOW_MS) >= LOCKOUT_BUDGET
 *      → link = { guarded, until: oldestSince(...) + LOCKOUT_WINDOW_MS }; emit; throw link_down
 * 3. fetch(baseUrl + '/v0/management' + path, { method, headers: { Authorization: `Bearer ${key.reveal()}`,
 *      'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) })
 *      connect error (ECONNREFUSED) → throw DeckError('cpa_unreachable')
 * 4. 401 | 403 → authFailures.record(now); link = { rejected, at: now, envPath }; emit;
 *      throw DeckError('link_down'). NEVER retried.
 * 5. other non-2xx → throw DeckError('cpa_error', `${status}`). The body is not included (it could echo input).
 * 6. return parse(await res.json()). The raw JSON goes out of scope here and is never logged.
 */
async function send<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: unknown,
  parse: (json: unknown) => T,
  timeoutMs: number,
): Promise<T> {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Wire schemas (private). They're lenient: unknown keys are stripped, and optional fields default.
// ---------------------------------------------------------------------------------------------

const WireCooldown = z.object({
  scope: z.enum(['credential', 'model']),
  model_key: z.string().optional(),
  reason: z.string(),
  retry_at: z.string(),
  http_status: z.number().optional(),
});

const WireQuota = z.object({ observed_at: z.string(), signals: z.record(z.string(), z.string()) });

const WireAuthFile = z.object({
  auth_index: z.string(),
  name: z.string(),
  email: z.string().optional(),
  provider: z.string(),
  account_type: z.string().optional(),
  disabled: z.boolean().default(false),
  priority: z.number().default(0),
  status: z.string().default('unknown'),
  status_message: z.string().default(''),
  unavailable: z.boolean().default(false),
  next_retry_after: z.string().optional(),
  cooldowns: z.array(WireCooldown).default([]),
  quota: WireQuota.optional(),
  model_quotas: z.record(z.string(), WireQuota).default({}),
  recent_requests: z.array(z.object({ time: z.string(), success: z.number(), failed: z.number() })).default([]),
  last_refresh: z.string().optional(),
  success: z.number().default(0),
  failed: z.number().default(0),
});

const WireAuthFiles = z.object({ files: z.array(WireAuthFile), observed_at: z.string() });

void WireAuthFiles;

/**
 * Exported for tests (test/derive.test.ts parses the real fixture through it). Returns domain types only.
 *
 * TODO:
 * files.filter(f => f.provider === 'claude')
 * headers: parseSignals(f.quota) where 'Anthropic-Ratelimit-Unified-<KEY>-<Field>' groups by KEY
 *   (KEY = '5h' | '7d' | '7d_oi' | 'Overage' | ...); fields Utilization → fractionToPercent,
 *   Reset → epochSecondsToInstant, Status → HeaderStatus. Unprefixed 'Anthropic-Ratelimit-Unified-Status'
 *   is the overall status. 'Representative-Claim', 'Overage-Disabled-Reason' are copied.
 *   models[] from model_quotas: observedAt + overall Status only.
 * activity: anchor recent_requests to the top-level observed_at.
 *   lastStart = floor(observed_at, 10 min); bucket[i].start = lastStart - (n-1-i) * 10 min.
 *   Check: the local "HH:MM" of lastStart equals the last label's prefix; if it's off by one
 *   bucket (observed exactly on a boundary), shift by 10 min. Labels are CPA-local wall time.
 * statusMessage: try JSON.parse(status_message).error.message, else the raw string, '' → null
 * cooldowns: drop remaining_seconds (it's derived from retry_at); unknown reason → 'unknown'
 * Also returns the id → name map for the private resolver.
 */
export function parseAuthFiles(json: unknown): {
  readonly accounts: readonly CpaAccount[];
  readonly observedAt: Instant;
  readonly names: ReadonlyMap<AccountId, string>;
} {
  throw new Error('not implemented');
}

/** The refresh response contains `auth.access_token` and `auth.refresh_token`. Keep only `ok`. */
export function parseRefresh(json: unknown): { readonly ok: boolean } {
  // TODO: return { ok: typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === true }
  throw new Error('not implemented');
}
