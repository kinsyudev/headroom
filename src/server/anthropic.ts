/**
 * Anthropic's OAuth endpoints, reached through CPA's /api-call, which substitutes the account's
 * token. Every Anthropic request leaves through `send`, which enforces the budget:
 * - one call in flight, and at least `gapMs` (10 s) between the starts of any two calls;
 * - a 429 or `rate_limit_error` backs off that account only: `retry-after` when present, else
 *   5, 10, 20, then 30 min; a 2xx resets it; backoff persists in state.json across restarts;
 * - nothing is sent for an account in backoff.
 * Scheduling (which account, which mode, when) belongs to poller.ts. Nothing here retries.
 */
import { z } from 'zod';
import type {
  AccountId,
  CedarEmber,
  ClaimOutcome,
  GrantId,
  Instant,
  JuniperTide,
  Limit,
  Percent,
  Profile,
  ReadMode,
  SourceError,
  Spend,
} from '../shared/domain';
import { parseInstant } from '../shared/domain';
import type { Cpa, UpstreamResult } from './cpa';
import type { StateFile } from './state';

const BASE = 'https://api.anthropic.com';
export const ANTHROPIC_GAP_MS = 10_000;
export const BACKOFF_LADDER_MS = [5, 10, 20, 30].map((m) => m * 60_000);
export const READ_TIMEOUT_MS = 20_000;
/** Claude Code gives the claim 25 s upstream; our wait on CPA must outlast it. */
export const CLAIM_TIMEOUT_MS = 35_000;

export const READ_PATH: Readonly<Record<ReadMode, string>> = {
  normal: '/api/oauth/usage?cedar_ember=1',
  wall: '/api/oauth/usage?at_wall=1&skip_spend=1',
};

export interface Clock {
  now(): Instant;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now() as Instant, sleep: (ms) => Bun.sleep(ms) };

export type UsageRead =
  | { readonly mode: 'normal'; readonly limits: readonly Limit[]; readonly spend: Spend | null; readonly cedar: CedarEmber | null }
  | { readonly mode: 'wall'; readonly limits: readonly Limit[]; readonly juniper: JuniperTide | null; readonly cedar: CedarEmber | null };

export type Polled<T> = { readonly ok: true; readonly value: T; readonly at: Instant } | { readonly ok: false; readonly error: SourceError; readonly at: Instant };

export type ClaimRequest =
  | { readonly program: 'juniper_tide'; readonly orgUuid: string }
  | { readonly program: 'cedar_ember'; readonly orgUuid: string; readonly grantId: GrantId; readonly requestId: string };

export type ClaimAttempt =
  | { readonly kind: 'answered'; readonly outcome: ClaimOutcome }
  | { readonly kind: 'not_sent'; readonly why: string }
  | { readonly kind: 'unknown'; readonly why: string };

export interface Anthropic {
  read(account: AccountId, mode: ReadMode): Promise<Polled<UsageRead>>;
  profile(account: AccountId): Promise<Polled<Profile>>;
  /** POST reset_rate_limits. IRREVERSIBLE. Only claims.ts calls it, once per user intent. */
  claim(account: AccountId, req: ClaimRequest): Promise<ClaimAttempt>;
  backoffUntil(account: AccountId): Instant | null;
}

/** The one place the Claude Code identity is built. Without it every program reads `ineligible: surface`. */
export function claudeHeaders(cliVersion: string): Record<string, string> {
  return {
    Authorization: 'Bearer $TOKEN$',
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    'User-Agent': `claude-cli/${cliVersion} (external, cli)`,
    'x-app': 'cli',
  };
}

type Sent = UpstreamResult | { readonly kind: 'held'; readonly until: Instant };

export function createAnthropic(deps: {
  readonly cpa: Cpa;
  readonly cliVersion: string;
  readonly clock: Clock;
  readonly state: StateFile;
  readonly gapMs?: number;
  readonly claimTimeoutMs?: number;
}): Anthropic {
  const gap = deps.gapMs ?? ANTHROPIC_GAP_MS;
  const streak = new Map<AccountId, number>();
  let tail: Promise<unknown> = Promise.resolve();
  let lastAt = -Infinity;

  function backoffUntil(account: AccountId): Instant | null {
    const until = deps.state.read().backoff[account];
    return until !== undefined && until > deps.clock.now() ? (until as Instant) : null;
  }

  function setBackoff(account: AccountId, retryAfterMs: number | null): void {
    const n = streak.get(account) ?? 0;
    streak.set(account, n + 1);
    const until = deps.clock.now() + (retryAfterMs ?? BACKOFF_LADDER_MS[Math.min(n, BACKOFF_LADDER_MS.length - 1)]!);
    deps.state.update((s) => ({ ...s, backoff: { ...liveBackoff(s.backoff), [account]: until } }));
  }

  function clearBackoff(account: AccountId): void {
    streak.delete(account);
    if (deps.state.read().backoff[account] === undefined) return;
    deps.state.update((s) => {
      const { [account]: _, ...rest } = s.backoff;
      return { ...s, backoff: liveBackoff(rest) };
    });
  }

  function liveBackoff(b: Readonly<Record<string, number>>): Record<string, number> {
    const now = deps.clock.now();
    return Object.fromEntries(Object.entries(b).filter(([, until]) => until > now));
  }

  function send(account: AccountId, method: 'GET' | 'POST', path: string, data: string | undefined, timeoutMs: number): Promise<Sent> {
    const run = async (): Promise<Sent> => {
      const wait = lastAt + gap - deps.clock.now();
      if (wait > 0) await deps.clock.sleep(wait);
      const held = backoffUntil(account);
      if (held !== null) return { kind: 'held', until: held };
      lastAt = deps.clock.now();
      const r = await deps.cpa.apiCall({
        account,
        method,
        url: BASE + path,
        header: claudeHeaders(deps.cliVersion),
        ...(data === undefined ? {} : { data }),
        timeoutMs,
      });
      if (r.kind === 'answered') {
        const limited = rateLimit(r);
        if (limited !== undefined) setBackoff(account, limited);
        else if (r.status < 400) clearBackoff(account);
      }
      return r;
    };
    const p = tail.then(run, run);
    tail = p.catch(() => undefined);
    return p;
  }

  function toPolled<T>(account: AccountId, r: Sent, parse: (json: unknown) => T): Polled<T> {
    const at = deps.clock.now();
    const fail = (error: SourceError): Polled<T> => ({ ok: false, error, at });
    if (r.kind === 'held') return fail({ kind: 'rate_limited', retryAt: r.until });
    if (r.kind === 'not_sent') return fail(deps.cpa.link().kind === 'ok' ? { kind: 'cpa_unreachable' } : { kind: 'link_down' });
    if (r.kind === 'unknown') return fail({ kind: 'upstream', status: 0, message: r.why });
    if (rateLimit(r) !== undefined) return fail({ kind: 'rate_limited', retryAt: backoffUntil(account) ?? at });
    if (r.status === 401 || r.status === 403) return fail({ kind: 'auth', status: r.status });
    const body = parseJson(r.body);
    if (r.status >= 400) return fail({ kind: 'upstream', status: r.status, message: errorMessage(body) });
    if (body === undefined) return fail({ kind: 'malformed', message: 'response is not JSON' });
    try {
      return { ok: true, value: parse(body), at };
    } catch (e) {
      return fail({ kind: 'malformed', message: e instanceof z.ZodError ? (e.issues[0]?.message ?? 'schema mismatch') : String(e) });
    }
  }

  return {
    backoffUntil,
    async read(account, mode) {
      return toPolled(account, await send(account, 'GET', READ_PATH[mode], undefined, READ_TIMEOUT_MS), (json) => parseUsage(json, mode));
    },
    async profile(account) {
      return toPolled(account, await send(account, 'GET', '/api/oauth/profile', undefined, READ_TIMEOUT_MS), parseProfile);
    },
    async claim(account, req) {
      const body =
        req.program === 'juniper_tide'
          ? { program: 'juniper_tide' }
          : { program: 'cedar_ember', grant_id: req.grantId, request_id: req.requestId };
      const r = await send(account, 'POST', `/api/organizations/${req.orgUuid}/reset_rate_limits`, JSON.stringify(body), deps.claimTimeoutMs ?? CLAIM_TIMEOUT_MS);
      if (r.kind === 'held') return { kind: 'not_sent', why: `rate-limited until ${new Date(r.until).toISOString()}` };
      if (r.kind !== 'answered') return r;
      if (rateLimit(r) !== undefined) return { kind: 'answered', outcome: { result: 'rate_limited', status: r.status } };
      if (r.status === 401 || r.status === 403) return { kind: 'answered', outcome: { result: 'auth_error', status: r.status } };
      const parsed = r.status < 300 ? WireClaimResponse.safeParse(parseJson(r.body)) : null;
      if (!parsed?.success) return { kind: 'unknown', why: `Anthropic answered ${r.status} with an unreadable body` };
      const w = parsed.data;
      if (!(CLAIM_RESULTS as readonly string[]).includes(w.result)) return { kind: 'unknown', why: `unrecognized result "${w.result}"` };
      return {
        kind: 'answered',
        outcome: {
          result: w.result as (typeof CLAIM_RESULTS)[number],
          reason: w.reason ?? null,
          resetsLeft: w.resets_left ?? null,
          cleared: w.cleared ?? [],
          nextAvailableAt: parseInstant(w.next_available_at ?? w.cooldown_until),
        },
      };
    },
  };
}

const CLAIM_RESULTS = ['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable'] as const;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(body: unknown): string {
  const m = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === 'string' ? m : '';
}

/** undefined when not rate limited; otherwise the retry-after in ms, or null when absent. */
function rateLimit(r: Extract<UpstreamResult, { kind: 'answered' }>): number | null | undefined {
  const body = parseJson(r.body) as { error?: { type?: unknown } } | undefined;
  if (r.status !== 429 && body?.error?.type !== 'rate_limit_error') return undefined;
  const s = Number(r.headers['retry-after']);
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

// Wire schemas: lenient, unknown keys dropped.

const WireSeverity = z.enum(['normal', 'warning', 'critical']).catch('normal');

const WireLimit = z.object({
  kind: z.string(),
  percent: z.number(),
  severity: WireSeverity,
  resets_at: z.string().nullable().optional(),
  scope: z
    .object({ model: z.object({ display_name: z.string().nullable().optional() }).nullable().optional() })
    .nullable()
    .optional()
    .catch(null),
  is_active: z.boolean().default(false),
});

const WireMoney = z.object({ amount_minor: z.number(), currency: z.string(), exponent: z.number() });

const WireSpend = z.object({
  used: WireMoney,
  limit: WireMoney.nullable().optional(),
  percent: z.number().nullable().optional(),
  severity: WireSeverity,
  enabled: z.boolean(),
  disabled_reason: z.string().nullable().optional(),
});

const WireJuniper = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullable().optional(),
  arm: z.string().nullable().optional(),
  available: z.boolean(),
  next_available_at: z.string().nullable().optional(),
  weekly_resets_at: z.string().nullable().optional(),
  resets_per_week: z.number().default(1),
});

const WireGrant = z.object({
  id: z.string(),
  label: z.string().default(''),
  type: z.string().default('session'),
  resets_total: z.number(),
  resets_left: z.number(),
  ends_at: z.string().nullable().optional(),
  clears: z.array(z.string()).default([]),
  paused: z.boolean().default(false),
  usable_now: z.boolean().default(false),
});

const WireCedar = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullable().optional(),
  at_limit: z.boolean().default(false),
  grants: z.array(WireGrant).default([]),
  next_grant_id: z.string().nullable().optional(),
  weekly_resets_at: z.string().nullable().optional(),
  cooldown_until: z.string().nullable().optional(),
});

const WireUsage = z.object({
  limits: z.array(WireLimit),
  spend: WireSpend.nullable().optional().catch(null),
  juniper_tide: WireJuniper.nullable().optional(),
  cedar_ember: WireCedar.nullable().optional(),
});

const WireProfile = z.object({
  account: z.object({ email: z.string() }),
  organization: z.object({
    uuid: z.guid(),
    name: z.string().default(''),
    organization_type: z.string().default(''),
    rate_limit_tier: z.string().default(''),
    plan_display_label: z.string().nullable().optional(),
  }),
});

const WireClaimResponse = z.object({
  result: z.string(),
  reason: z.string().nullable().optional(),
  resets_left: z.number().nullable().optional(),
  cleared: z.array(z.string()).optional(),
  next_available_at: z.string().nullable().optional(),
  cooldown_until: z.string().nullable().optional(),
});

/** Exported for tests. `normal` keeps spend and drops juniper; `wall` keeps juniper and drops spend. */
export function parseUsage(json: unknown, mode: ReadMode): UsageRead {
  const w = WireUsage.parse(json);
  const limits: Limit[] = w.limits.map((l) => ({
    kind: l.kind,
    percent: l.percent as Percent,
    severity: l.severity,
    resetsAt: parseInstant(l.resets_at),
    scopeModel: l.scope?.model?.display_name ?? null,
    isActive: l.is_active,
  }));
  const c = w.cedar_ember;
  const cedar: CedarEmber | null = c
    ? {
        eligible: c.eligible,
        ineligibleReason: c.ineligible_reason ?? null,
        atLimit: c.at_limit,
        grants: c.grants.map((g) => ({
          id: g.id as GrantId,
          label: g.label,
          type: g.type,
          resetsTotal: g.resets_total,
          resetsLeft: g.resets_left,
          endsAt: parseInstant(g.ends_at),
          clears: g.clears,
          paused: g.paused,
          usableNow: g.usable_now,
        })),
        nextGrantId: (c.next_grant_id ?? null) as GrantId | null,
        weeklyResetsAt: parseInstant(c.weekly_resets_at),
        cooldownUntil: parseInstant(c.cooldown_until),
      }
    : null;
  if (mode === 'wall') {
    const j = w.juniper_tide;
    const juniper: JuniperTide | null = j
      ? {
          eligible: j.eligible,
          ineligibleReason: j.ineligible_reason ?? null,
          arm: j.arm ?? null,
          available: j.available,
          nextAvailableAt: parseInstant(j.next_available_at),
          weeklyResetsAt: parseInstant(j.weekly_resets_at),
          resetsPerWeek: j.resets_per_week,
        }
      : null;
    return { mode, limits, juniper, cedar };
  }
  const s = w.spend;
  const spend: Spend | null = s
    ? {
        enabled: s.enabled,
        used: { minor: s.used.amount_minor, currency: s.used.currency, exponent: s.used.exponent },
        limit: s.limit ? { minor: s.limit.amount_minor, currency: s.limit.currency, exponent: s.limit.exponent } : null,
        percent: (s.percent ?? null) as Percent | null,
        severity: s.severity,
        disabledReason: s.disabled_reason ?? null,
      }
    : null;
  return { mode, limits, spend, cedar };
}

export function parseProfile(json: unknown): Profile {
  const w = WireProfile.parse(json);
  return {
    email: w.account.email,
    orgUuid: w.organization.uuid,
    orgName: w.organization.name,
    orgType: w.organization.organization_type,
    rateLimitTier: w.organization.rate_limit_tier,
    planLabel: w.organization.plan_display_label ?? null,
  };
}
