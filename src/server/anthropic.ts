/**
 * Anthropic OAuth endpoints, reached through CPA's /api-call (which substitutes the account's token).
 * This module knows the URLs, the Claude Code headers, and the response shapes. It returns domain types.
 *
 * Load-bearing details:
 * - `User-Agent: claude-cli/<v> (external, cli)` and `x-app: cli` are required. Without them every
 *   program reports `ineligible_reason: "surface"`. They're built in one place (claudeHeaders).
 * - api-call returns HTTP 200 whenever the call was made. The real status is `status_code`.
 * - Rate limiting shows up as status 429 OR as a body `{error:{type:"rate_limit_error"}}`. All six
 *   captured usage fixtures are the second form. classify() treats both as rate_limited and reads
 *   `retry-after` from the relayed headers when present.
 * - None of this module's functions retry. Cadence and backoff belong to observer.ts; claims never retry.
 */
import { z } from 'zod';
import type { AccountId, Instant, Limit, Profile, ResetPrograms, SourceError, Spend } from '../shared/domain';
import type { Cpa, UpstreamResult } from './cpa';

const BASE = 'https://api.anthropic.com';

export interface Anthropic {
  /** GET /api/oauth/usage → limits[] and spend. */
  usage(account: AccountId): Promise<Polled<{ readonly limits: readonly Limit[]; readonly spend: Spend | null }>>;
  /** GET /api/oauth/usage?at_wall=1&skip_spend=1 → limits[] and both reset programs. */
  atWall(account: AccountId): Promise<Polled<{ readonly limits: readonly Limit[]; readonly programs: ResetPrograms }>>;
  /** GET /api/oauth/profile. Cache it for hours (observer.ts owns the cache). */
  profile(account: AccountId): Promise<Polled<Profile>>;
  /**
   * POST /api/organizations/{org}/reset_rate_limits. IRREVERSIBLE. Called only by claims.ts, once per
   * claim row, after the row is durably in 'sending'. Never throws for upstream outcomes; see ClaimAttempt.
   */
  claimReset(account: AccountId, req: ClaimRequest): Promise<ClaimAttempt>;
}

/** A poll result. Errors are values, so observer.ts can store them in Source.error without try/catch ladders. */
export type Polled<T> = { readonly ok: true; readonly value: T; readonly at: Instant } | { readonly ok: false; readonly error: SourceError; readonly at: Instant };

export type ClaimRequest =
  | { readonly program: 'juniper_tide'; readonly orgUuid: string }
  | { readonly program: 'cedar_ember'; readonly orgUuid: string; readonly grantId: string; readonly requestId: string };

export type ClaimAttempt =
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly result: 'reset' | 'already_used' | 'not_limited' | 'cooldown' | 'ineligible' | 'unavailable' | 'rate_limited' | 'auth_error' | 'unrecognized';
      readonly reason: string | null;
      readonly resetsLeft: number | null;
      readonly cleared: readonly string[];
      readonly nextAvailableAt: Instant | null;
      readonly cooldownUntil: Instant | null;
    }
  | { readonly kind: 'not_sent'; readonly why: string }
  | { readonly kind: 'unknown'; readonly why: string };

export const CLAIM_UPSTREAM_TIMEOUT_MS = 25_000;
export const CLAIM_CPA_TIMEOUT_MS = 35_000;
export const POLL_TIMEOUT_MS = 15_000;

export function createAnthropic(deps: { readonly cpa: Cpa; readonly cliVersion: string; readonly now: () => Instant }): Anthropic {
  throw new Error('not implemented');
}

/** The one place the Claude Code impersonation headers are built. */
export function claudeHeaders(cliVersion: string): Record<string, string> {
  return {
    Authorization: 'Bearer $TOKEN$',
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    'User-Agent': `claude-cli/${cliVersion} (external, cli)`,
    'x-app': 'cli',
  };
}

/**
 * Turn an api-call result into a domain value or a SourceError.
 * TODO:
 * not_sent | unknown → { upstream, status 0, why } (polls don't distinguish them; claims do, separately)
 * answered:
 *   body is a string → try JSON.parse; failure → malformed
 *   status 429 || body.error?.type === 'rate_limit_error'
 *     → rate_limited { retryAt: now + (retry-after header seconds ?? 0) * 1000 }. observer applies max(retryAt, backoff).
 *   status 401 | 403 → auth { status }   (token problem at Anthropic; CPA refresh may fix it)
 *   status >= 400 → upstream { status, message: body.error?.message ?? '' }
 *   else schema.safeParse(body) → ok | malformed
 */
function classify<T>(r: UpstreamResult, schema: z.ZodType<T>, now: Instant): Polled<T> {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Wire schemas (private, lenient). Shapes follow docs/upstream.md. No 200 fixtures exist yet for
// usage and at_wall (all captures were rate-limited), so the parsers are written against the doc
// and must ignore unknown keys. Codename keys like `tangelo` and `amber_cistern` are dropped.
// ---------------------------------------------------------------------------------------------

const WireLimit = z.object({
  kind: z.string(),
  group: z.string(),
  percent: z.number(),
  severity: z.enum(['normal', 'warning', 'critical']).catch('normal'),
  resets_at: z.string().nullable(),
  scope: z.object({ model: z.object({ display_name: z.string() }) }).nullable().catch(null),
  is_active: z.boolean().default(false),
});

const WireJuniper = z
  .object({
    eligible: z.boolean(),
    ineligible_reason: z.string().nullable(),
    in_experiment: z.boolean().default(false),
    arm: z.string().nullable(),
    available: z.boolean(),
    next_available_at: z.string().nullable(),
    weekly_resets_at: z.string().nullable(),
    resets_per_week: z.number().default(1),
  })
  .nullable();

const WireGrant = z.object({
  id: z.string(),
  label: z.string().default(''),
  type: z.string().default('session'),
  resets_total: z.number(),
  resets_left: z.number(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  clears: z.array(z.string()).default([]),
  paused: z.boolean().default(false),
  usable_now: z.boolean().default(false),
  use_requires_limit: z.boolean().default(true),
});

const WireCedar = z
  .object({
    eligible: z.boolean(),
    ineligible_reason: z.string().nullable(),
    at_limit: z.boolean().default(false),
    grants: z.array(WireGrant).default([]),
    next_grant_id: z.string().nullable().optional(),
    weekly_resets_at: z.string().nullable().optional(),
    cooldown_until: z.string().nullable().optional(),
    paused_held: z.boolean().default(false),
  })
  .nullable();

const WireMoney = z.object({ amount_minor: z.number(), currency: z.string(), exponent: z.number() });

const WireUsage = z.object({
  limits: z.array(WireLimit).default([]),
  spend: z
    .object({
      used: WireMoney,
      limit: WireMoney.nullable(),
      percent: z.number().nullable(),
      severity: z.enum(['normal', 'warning', 'critical']).catch('normal'),
      enabled: z.boolean(),
      disabled_reason: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

const WireAtWall = z.object({
  limits: z.array(WireLimit).default([]),
  juniper_tide: WireJuniper.optional().default(null),
  cedar_ember: WireCedar.optional().default(null),
});

const WireClaimResponse = z.object({
  result: z.string(),
  reason: z.string().nullable().optional(),
  resets_left: z.number().nullable().optional(),
  cleared: z.array(z.string()).optional(),
  next_available_at: z.string().nullable().optional(),
  weekly_resets_at: z.string().nullable().optional(),
  cooldown_until: z.string().nullable().optional(),
});

void [WireUsage, WireAtWall, WireClaimResponse];

/**
 * TODO: build the request. juniper body {"program":"juniper_tide"}; cedar body
 * {"program":"cedar_ember","grant_id":..,"request_id":..}. timeoutMs = CLAIM_CPA_TIMEOUT_MS.
 * Map UpstreamResult:
 *   not_sent → not_sent
 *   unknown  → unknown
 *   answered: 429 → result 'rate_limited'; 401|403 → 'auth_error' (neither consumed a reset);
 *             2xx → parse WireClaimResponse; a result string outside the known set → 'unrecognized'
 *             (claims.ts treats unrecognized as in_doubt: the reset might have been consumed);
 *             other status → 'unrecognized'.
 */
function toClaimAttempt(r: UpstreamResult, now: Instant): ClaimAttempt {
  throw new Error('not implemented');
}
