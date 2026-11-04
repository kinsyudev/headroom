declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Instant = Brand<number, 'Instant'>;
export type AccountId = Brand<string, 'AccountId'>;
/** Percent of a window used. It can exceed 100 (header overage utilization 1.01 is 101). */
export type Percent = Brand<number, 'Percent'>;
export type GrantId = Brand<string, 'GrantId'>;
export type ClaimId = Brand<string, 'ClaimId'>;
export type FlowId = Brand<string, 'FlowId'>;

/**
 * Upstream sends at least three time formats:
 *   CPA RFC3339 with up to 9 fractional digits and an offset  2026-11-04T13:25:39.44912+01:00
 *   header epoch seconds as strings                            "1793811600"
 *   Anthropic RFC3339                                          2026-11-07T09:00:00Z
 */
export function parseInstant(text: string | null | undefined): Instant | null {
  if (!text) return null;
  const normalized = text.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? (ms as Instant) : null;
}

export function epochSecondsToInstant(s: string | number | null | undefined): Instant | null {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? ((n * 1000) as Instant) : null;
}

/** Header utilization is a 0..1 fraction ("0.17"); Anthropic `/usage` is already 0..100. */
export function fractionToPercent(f: string | number | null | undefined): Percent | null {
  if (f === null || f === undefined || f === '') return null;
  const n = Number(f);
  return Number.isFinite(n) ? (Math.round(n * 10_000) / 100 as Percent) : null;
}

export interface Sample<T> {
  readonly value: T;
  readonly at: Instant;
}

export interface Source<T> {
  readonly last: Sample<T> | null;
  readonly error: Sample<SourceError> | null;
  readonly attemptedAt: Instant | null;
  readonly nextAt: Instant | null;
}

export function emptySource<T>(): Source<T> {
  return { last: null, error: null, attemptedAt: null, nextAt: null };
}

export type SourceError =
  | { readonly kind: 'rate_limited'; readonly retryAt: Instant }
  | { readonly kind: 'read_cap'; readonly retryAt: Instant }
  | { readonly kind: 'auth'; readonly status: number }
  | { readonly kind: 'cpa_unreachable' }
  | { readonly kind: 'link_down' }
  | { readonly kind: 'upstream'; readonly status: number; readonly message: string }
  | { readonly kind: 'malformed'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

export type RoutingStrategy = 'fill-first' | 'round-robin';
export type CpaStatus = 'active' | 'error' | 'disabled' | 'pending' | 'refreshing' | 'unknown';
export const COOLDOWN_REASONS = [
  'quota',
  'credential_quota',
  'unauthorized',
  'payment_required',
  'not_found',
  'invalid_grant',
  'cloudflare_challenge',
  'model_not_supported',
  'transient_error',
  'unknown',
] as const;
export type CooldownReason = (typeof COOLDOWN_REASONS)[number];

export interface Cooldown {
  readonly model: string | null;
  readonly reason: CooldownReason;
  readonly retryAt: Instant;
  readonly httpStatus: number | null;
}

export type HeaderStatus = 'allowed' | 'allowed_warning' | 'rejected';

export interface HeaderWindow {
  readonly key: string;
  readonly percent: Percent | null;
  readonly resetsAt: Instant | null;
  readonly status: HeaderStatus | null;
}

/**
 * The headers of the last real response CPA proxied on this account. Updated only by traffic,
 * held in CPA's memory, and gone after a CPA restart.
 */
export interface HeaderQuota {
  readonly observedAt: Instant;
  readonly status: HeaderStatus | null;
  readonly resetsAt: Instant | null;
  readonly windows: readonly HeaderWindow[];
  readonly overageDisabledReason: string | null;
}

export interface ActivityBucket {
  readonly start: Instant;
  readonly success: number;
  readonly failed: number;
}

export interface CpaAccount {
  readonly id: AccountId;
  readonly email: string;
  readonly disabled: boolean;
  readonly priority: number;
  readonly status: CpaStatus;
  readonly statusMessage: string | null;
  readonly unavailable: boolean;
  readonly nextRetryAfter: Instant | null;
  readonly cooldowns: readonly Cooldown[];
  readonly headers: HeaderQuota | null;
  readonly lastRefresh: Instant | null;
  readonly activity: readonly ActivityBucket[];
}

export type Severity = 'normal' | 'warning' | 'critical';

export interface Limit {
  readonly kind: 'session' | 'weekly_all' | 'weekly_scoped' | (string & {});
  readonly percent: Percent;
  readonly severity: Severity;
  readonly resetsAt: Instant | null;
  readonly scopeModel: string | null;
  /** The limit currently binding. */
  readonly isActive: boolean;
}

export interface Money {
  readonly minor: number;
  readonly currency: string;
  readonly exponent: number;
}

export interface Spend {
  readonly enabled: boolean;
  readonly used: Money;
  readonly limit: Money | null;
  readonly percent: Percent | null;
  readonly severity: Severity;
  readonly disabledReason: string | null;
}

/** juniper_tide: the weekly session-limit reset. Only `wall` reads carry it. */
export interface JuniperTide {
  readonly eligible: boolean;
  readonly ineligibleReason: string | null;
  readonly arm: string | null;
  readonly available: boolean;
  readonly nextAvailableAt: Instant | null;
  readonly weeklyResetsAt: Instant | null;
  readonly resetsPerWeek: number;
}

export interface Grant {
  readonly id: GrantId;
  readonly label: string;
  readonly type: string;
  readonly resetsTotal: number;
  readonly resetsLeft: number;
  readonly endsAt: Instant | null;
  readonly clears: readonly string[];
  readonly paused: boolean;
  readonly usableNow: boolean;
}

/** cedar_ember: grant-based resets. */
export interface CedarEmber {
  readonly eligible: boolean;
  readonly ineligibleReason: string | null;
  readonly atLimit: boolean;
  readonly grants: readonly Grant[];
  readonly nextGrantId: GrantId | null;
  readonly weeklyResetsAt: Instant | null;
  readonly cooldownUntil: Instant | null;
}

export interface Profile {
  readonly email: string;
  readonly orgUuid: string;
  readonly orgName: string;
  readonly orgType: string;
  readonly rateLimitTier: string;
  readonly planLabel: string | null;
}

export type ReadMode = 'normal' | 'wall';

export interface AccountFeeds {
  readonly limits: Source<readonly Limit[]>;
  readonly spend: Source<Spend | null>;
  readonly cedar: Source<CedarEmber | null>;
  readonly juniper: Source<JuniperTide | null>;
  readonly profile: Source<Profile>;
  readonly gate: ReadGate;
}

export interface ReadGate {
  readonly backoffUntil: Instant | null;
  readonly capUntil: Instant | null;
  readonly manualAt: Instant | null;
  readonly reading: ReadMode | 'profile' | null;
}

export function emptyFeeds(): AccountFeeds {
  return {
    limits: emptySource(),
    spend: emptySource(),
    cedar: emptySource(),
    juniper: emptySource(),
    profile: emptySource(),
    gate: { backoffUntil: null, capUntil: null, manualAt: null, reading: null },
  };
}

export interface ServingSeen {
  readonly account: AccountId;
  readonly lastAt: Instant;
  readonly recent: number;
}

export type ProgramId = 'juniper_tide' | 'cedar_ember';

export type ClaimOutcome =
  | {
      readonly result: 'reset' | 'already_used' | 'not_limited' | 'cooldown' | 'ineligible' | 'unavailable';
      readonly reason: string | null;
      readonly resetsLeft: number | null;
      readonly cleared: readonly string[];
      readonly nextAvailableAt: Instant | null;
    }
  | { readonly result: 'rate_limited' | 'auth_error'; readonly status: number }
  | { readonly result: 'not_sent'; readonly why: string };

export type ClaimState =
  | { readonly kind: 'sending' }
  | {
      readonly kind: 'settled';
      readonly at: Instant;
      readonly outcome: ClaimOutcome;
      readonly followup: 'not_needed' | 'done' | 'failed';
    }
  | { readonly kind: 'maybe_sent'; readonly at: Instant; readonly why: string };

export interface ClaimRecord {
  readonly id: ClaimId;
  readonly account: AccountId;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
  readonly startedAt: Instant;
  readonly state: ClaimState;
}

export interface OAuthFlow {
  readonly id: FlowId;
  readonly url: string;
  readonly startedAt: Instant;
  readonly status: 'waiting' | 'ok' | 'error' | 'expired' | 'cancelled';
  readonly error: string | null;
  readonly account: AccountId | null;
}

export type LinkState =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing_key'; readonly envPath: string }
  | { readonly kind: 'rejected'; readonly at: Instant; readonly envPath: string };

export interface Snapshot {
  readonly generatedAt: Instant;
  readonly link: LinkState; // cpa.ts
  readonly cpa: Source<readonly CpaAccount[]>; // observer.ts
  readonly strategy: Source<RoutingStrategy>; // observer.ts
  readonly feeds: Readonly<Record<AccountId, AccountFeeds>>;
  readonly serving: Source<readonly ServingSeen[]>;
  readonly claims: readonly ClaimRecord[];
  readonly flows: readonly OAuthFlow[]; // oauth.ts
}
