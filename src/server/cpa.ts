/**
 * CPA management API client: the only module that talks to CPA and the only one that sees the
 * management key.
 *
 * CPA bans an IP for 30 minutes after 5 failed authentications, and that ban also locks out
 * keeper. So no request is built without a key, and the first 401/403 latches `rejected` in
 * memory and in state.json. While latched, nothing is sent with that key for KEY_REJECT_LATCH_MS,
 * which keeps any restart loop under one strike per ban window. A different key in the env file
 * lifts the latch at once.
 *
 * Wire shapes are parsed here into domain types. The refresh response's token material and the
 * file `name` CPA needs for PATCH never leave this module.
 */
import { z } from 'zod';
import { DeckError } from '../shared/actions';
import { KEY_REJECT_LATCH_MS } from '../shared/derive';
import {
  COOLDOWN_REASONS,
  epochSecondsToInstant,
  fractionToPercent,
  parseInstant,
  type AccountId,
  type ActivityBucket,
  type CooldownReason,
  type CpaAccount,
  type CpaStatus,
  type HeaderQuota,
  type HeaderStatus,
  type HeaderWindow,
  type Instant,
  type LinkState,
  type RoutingStrategy,
} from '../shared/domain';
import type { Secret } from './config';
import type { StateFile } from './state';

export const MANAGEMENT_TIMEOUT_MS = 10_000;

/** A request for CPA's /api-call proxy. CPA substitutes `$TOKEN$` with the account's OAuth token. */
export interface UpstreamRequest {
  readonly account: AccountId;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly header: Readonly<Record<string, string>>;
  readonly data?: string;
  readonly timeoutMs: number;
}

/**
 * - answered: CPA made the call and relayed Anthropic's reply.
 * - not_sent: Anthropic was certainly not contacted.
 * - unknown: the request may have left (timeout, dropped connection, CPA 5xx).
 */
export type UpstreamResult =
  | { readonly kind: 'answered'; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly kind: 'not_sent'; readonly why: string }
  | { readonly kind: 'unknown'; readonly why: string };

export type OAuthStatus = { readonly kind: 'wait' } | { readonly kind: 'ok' } | { readonly kind: 'error'; readonly error: string };

export interface Cpa {
  link(): LinkState;
  listAccounts(): Promise<{ readonly accounts: readonly CpaAccount[]; readonly observedAt: Instant }>;
  getStrategy(): Promise<RoutingStrategy>;
  setStrategy(strategy: RoutingStrategy): Promise<void>;
  setDisabled(account: AccountId, disabled: boolean): Promise<void>;
  setPriority(account: AccountId, priority: number): Promise<void>;
  /** CPA `POST /reset-quota`: clears CPA's local cooldown. Never contacts Anthropic. */
  clearCooldown(account: AccountId): Promise<void>;
  refreshToken(account: AccountId): Promise<{ readonly ok: boolean }>;
  startOAuth(): Promise<{ readonly url: string; readonly state: string }>;
  oauthStatus(state: string): Promise<OAuthStatus>;
  /** Never throws for upstream outcomes. */
  apiCall(req: UpstreamRequest): Promise<UpstreamResult>;
}

export function createCpa(opts: {
  readonly baseUrl: string;
  readonly envPath: string;
  readonly readKey: () => Secret | null;
  readonly state: StateFile;
  readonly now: () => Instant;
}): Cpa {
  const base = `${opts.baseUrl.replace(/\/$/, '')}/v0/management`;
  let key = opts.readKey();
  let names: ReadonlyMap<AccountId, string> = new Map();

  function link(): LinkState {
    if (!key) return { kind: 'missing_key', envPath: opts.envPath };
    const r = opts.state.read().keyRejected;
    if (r && r.keyHash === key.hash() && opts.now() - r.at < KEY_REJECT_LATCH_MS) {
      return { kind: 'rejected', at: r.at as Instant, envPath: opts.envPath };
    }
    return { kind: 'ok' };
  }

  /** Re-reads the env file whenever the link is down, so a fixed key takes effect without a restart. */
  function usableKey(): Secret {
    if (link().kind !== 'ok') key = opts.readKey();
    const l = link();
    if (l.kind !== 'ok' || !key) throw new DeckError('link_down', l.kind === 'rejected' ? 'CPA rejected the management key' : 'no management key');
    return key;
  }

  function nameOf(account: AccountId): string {
    const n = names.get(account);
    if (!n) throw new DeckError('unknown_account', `no CPA auth file for ${account}`);
    return n;
  }

  async function send(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown, timeoutMs = MANAGEMENT_TIMEOUT_MS): Promise<unknown> {
    const k = usableKey();
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${k.reveal()}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new DeckError('cpa_unreachable', isTimeout(e) ? 'CPA timed out' : 'CPA is not answering');
    }
    if (res.status === 401 || res.status === 403) {
      opts.state.update((s) => ({ ...s, keyRejected: { keyHash: k.hash(), at: opts.now() } }));
      throw new DeckError('link_down', 'CPA rejected the management key');
    }
    if (opts.state.read().keyRejected) opts.state.update((s) => ({ ...s, keyRejected: null }));
    if (!res.ok) throw new DeckError('cpa_error', `CPA answered ${res.status} for ${method} ${path.split('?')[0]}`);
    return res.json();
  }

  return {
    link,
    async listAccounts() {
      const parsed = parseAuthFiles(await send('GET', '/auth-files'));
      names = parsed.names;
      return { accounts: parsed.accounts, observedAt: parsed.observedAt };
    },
    async getStrategy() {
      return WireStrategy.parse(await send('GET', '/routing/strategy')).strategy;
    },
    async setStrategy(strategy) {
      await send('PUT', '/routing/strategy', { value: strategy });
    },
    async setDisabled(account, disabled) {
      await send('PATCH', '/auth-files/status', { name: nameOf(account), disabled });
    },
    async setPriority(account, priority) {
      await send('PATCH', '/auth-files/fields', { name: nameOf(account), priority });
    },
    async clearCooldown(account) {
      await send('POST', '/reset-quota', { auth_index: account });
    },
    async refreshToken(account) {
      return parseRefresh(await send('POST', '/auth-files/refresh', { name: nameOf(account) }));
    },
    async startOAuth() {
      const r = z.object({ url: z.string().url(), state: z.string().min(1) }).parse(await send('GET', '/anthropic-auth-url?is_webui=true'));
      return { url: r.url, state: r.state };
    },
    async oauthStatus(state) {
      const r = z
        .object({ status: z.string(), error: z.string().optional() })
        .parse(await send('GET', `/get-auth-status?state=${encodeURIComponent(state)}`));
      if (r.status === 'ok') return { kind: 'ok' };
      if (r.status === 'error') return { kind: 'error', error: r.error ?? 'OAuth failed' };
      return { kind: 'wait' };
    },
    async apiCall(req) {
      let k: Secret;
      try {
        k = usableKey();
      } catch (e) {
        return { kind: 'not_sent', why: (e as Error).message };
      }
      let res: Response;
      try {
        res = await fetch(`${base}/api-call`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${k.reveal()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_index: req.account, method: req.method, url: req.url, header: req.header, ...(req.data === undefined ? {} : { data: req.data }) }),
          signal: AbortSignal.timeout(req.timeoutMs),
        });
      } catch (e) {
        if (isRefused(e)) return { kind: 'not_sent', why: 'CPA is not answering' };
        return { kind: 'unknown', why: isTimeout(e) ? 'timed out waiting for CPA' : 'connection to CPA dropped' };
      }
      if (res.status === 401 || res.status === 403) {
        opts.state.update((s) => ({ ...s, keyRejected: { keyHash: k.hash(), at: opts.now() } }));
        return { kind: 'not_sent', why: 'CPA rejected the management key' };
      }
      if (res.status >= 500) return { kind: 'unknown', why: `CPA answered ${res.status}` };
      if (!res.ok) return { kind: 'not_sent', why: `CPA answered ${res.status}` };
      const env = WireApiCall.safeParse(await res.json().catch(() => null));
      if (!env.success) return { kind: 'unknown', why: 'unreadable api-call envelope' };
      return { kind: 'answered', status: env.data.status_code, headers: flattenHeaders(env.data.header), body: env.data.body };
    },
  };
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

function isRefused(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  return code === 'ConnectionRefused' || code === 'ECONNREFUSED' || /Unable to connect/i.test((e as Error)?.message ?? '');
}

function flattenHeaders(h: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? (v[0] ?? '') : v]));
}

const WireApiCall = z.object({
  status_code: z.number(),
  header: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  body: z.string().default(''),
});

const WireStrategy = z.object({ strategy: z.enum(['fill-first', 'round-robin']) });

const WireCooldown = z.object({
  scope: z.string(),
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
  account: z.string().optional(),
  provider: z.string(),
  disabled: z.boolean().default(false),
  priority: z.number().default(0),
  status: z.string().default('unknown'),
  status_message: z.string().default(''),
  unavailable: z.boolean().default(false),
  next_retry_after: z.string().optional(),
  cooldowns: z.array(WireCooldown).default([]),
  quota: WireQuota.optional(),
  recent_requests: z.array(z.object({ time: z.string(), success: z.number(), failed: z.number() })).default([]),
  last_refresh: z.string().optional(),
});

const WireAuthFiles = z.object({ files: z.array(WireAuthFile), observed_at: z.string() });

const CPA_STATUSES: readonly CpaStatus[] = ['active', 'error', 'disabled', 'pending', 'refreshing', 'unknown'];
const HEADER_PREFIX = 'Anthropic-Ratelimit-Unified-';
const TEN_MIN = 600_000;

/** Exported for tests. Returns domain types plus the private id-to-file-name map. */
export function parseAuthFiles(json: unknown): {
  readonly accounts: readonly CpaAccount[];
  readonly observedAt: Instant;
  readonly names: ReadonlyMap<AccountId, string>;
} {
  const wire = WireAuthFiles.parse(json);
  const observedAt = parseInstant(wire.observed_at) ?? (Date.now() as Instant);
  const names = new Map<AccountId, string>();
  const accounts = wire.files
    .filter((f) => f.provider === 'claude')
    .map((f): CpaAccount => {
      const id = f.auth_index as AccountId;
      names.set(id, f.name);
      return {
        id,
        email: f.email ?? f.account ?? f.name,
        disabled: f.disabled,
        priority: f.priority,
        status: (CPA_STATUSES as readonly string[]).includes(f.status) ? (f.status as CpaStatus) : 'unknown',
        statusMessage: parseStatusMessage(f.status_message),
        unavailable: f.unavailable,
        nextRetryAfter: parseInstant(f.next_retry_after),
        cooldowns: f.cooldowns.flatMap((c) => {
          const retryAt = parseInstant(c.retry_at);
          if (retryAt === null) return [];
          const reason = (COOLDOWN_REASONS as readonly string[]).includes(c.reason) ? (c.reason as CooldownReason) : 'unknown';
          return [{ model: c.scope === 'credential' ? null : (c.model_key ?? null), reason, retryAt, httpStatus: c.http_status ?? null }];
        }),
        headers: f.quota ? parseSignals(f.quota) : null,
        lastRefresh: parseInstant(f.last_refresh),
        activity: anchorActivity(f.recent_requests, observedAt),
      };
    });
  return { accounts, observedAt, names };
}

function parseStatusMessage(raw: string): string | null {
  if (!raw) return null;
  try {
    const m = (JSON.parse(raw) as { error?: { message?: unknown } }).error?.message;
    return typeof m === 'string' && m ? m : raw;
  } catch {
    return raw;
  }
}

function parseSignals(q: z.infer<typeof WireQuota>): HeaderQuota | null {
  const observedAt = parseInstant(q.observed_at);
  if (observedAt === null) return null;
  const overall = new Map<string, string>();
  const groups = new Map<string, Map<string, string>>();
  for (const [name, value] of Object.entries(q.signals)) {
    if (!name.startsWith(HEADER_PREFIX)) continue;
    const rest = name.slice(HEADER_PREFIX.length);
    const dash = rest.indexOf('-');
    if (dash === -1 || ['Representative-Claim', 'Fallback-Percentage', 'Upgrade-Paths'].includes(rest)) {
      overall.set(rest, value);
      continue;
    }
    const key = rest.slice(0, dash);
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key)!.set(rest.slice(dash + 1), value);
  }
  const windows: HeaderWindow[] = [...groups].map(([key, f]) => ({
    key,
    percent: fractionToPercent(f.get('Utilization')),
    resetsAt: epochSecondsToInstant(f.get('Reset')),
    status: headerStatus(f.get('Status')),
  }));
  return {
    observedAt,
    status: headerStatus(overall.get('Status')),
    resetsAt: epochSecondsToInstant(overall.get('Reset')),
    windows,
    overageDisabledReason: groups.get('Overage')?.get('Disabled-Reason') ?? null,
  };
}

function headerStatus(s: string | undefined): HeaderStatus | null {
  return s === 'allowed' || s === 'allowed_warning' || s === 'rejected' ? s : null;
}

/**
 * CPA labels buckets in its own wall-clock time ("13:20-13:30") and anchors them to the top-level
 * observed_at. The newest bucket is the 10 minutes containing observed_at; if its label's minutes
 * disagree (observed exactly on a boundary), step back one bucket.
 */
function anchorActivity(buckets: readonly { time: string; success: number; failed: number }[], observedAt: Instant): ActivityBucket[] {
  let last = Math.floor(observedAt / TEN_MIN) * TEN_MIN;
  const labelMinute = Number(/^\d{1,2}:(\d{2})/.exec(buckets.at(-1)?.time ?? '')?.[1]);
  if (Number.isFinite(labelMinute) && new Date(last).getUTCMinutes() !== labelMinute) last -= TEN_MIN;
  const n = buckets.length;
  return buckets.map((b, i) => ({ start: (last - (n - 1 - i) * TEN_MIN) as Instant, success: b.success, failed: b.failed }));
}

/** The refresh response contains access and refresh tokens. Only `ok` survives. */
export function parseRefresh(json: unknown): { readonly ok: boolean } {
  return { ok: typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === true };
}
