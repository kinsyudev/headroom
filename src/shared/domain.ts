/**
 * Normalized observations: everything the server knows about the outside world, in domain terms.
 *
 * This file is the contract between server and UI. `Snapshot` is what /api/stream pushes, and it is
 * the only input to `deriveDeck` (shared/derive.ts). Upstream wire shapes never appear here: CPA
 * auth-files JSON, Anthropic usage JSON, and `Anthropic-Ratelimit-*` header strings are parsed and
 * dropped inside server/cpa.ts and server/anthropic.ts.
 *
 * Rules for this file:
 * - Facts, not conclusions. "claimable", "serving", "stale", "rolled", and "headroom" are derived
 *   in derive.ts from these facts plus `now`. Don't add a field that derive.ts could compute.
 *   Example: CPA's `remaining_seconds` is dropped because it's `retryAt - now`.
 * - JSON-safe values only (no Date, Map, or class). A Snapshot crosses SSE unchanged.
 * - Every time is an `Instant` (epoch ms) and every percent is a `Percent` on the 0..100 scale.
 *   The conversion happens once, at the parse boundary.
 * - Each top-level part of `Snapshot` has exactly one writer, named in its doc comment.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Epoch milliseconds. Only boundary parsers (below) and clocks create these. */
export type Instant = Brand<number, 'Instant'>;
/** CPA `auth_index`: stable 16-hex id. It's the join key across CPA, api-call, and keeper rows. */
export type AccountId = Brand<string, 'AccountId'>;
/** Percent of a window used, 0..100. It can exceed 100 (header overage utilization 1.01 → 101). */
export type Percent = Brand<number, 'Percent'>;
export type GrantId = Brand<string, 'GrantId'>;
/** UUID v4. It's also sent as cedar_ember `request_id`: one per user intent. */
export type ClaimId = Brand<string, 'ClaimId'>;
export type FlowId = Brand<string, 'FlowId'>;

// ---------------------------------------------------------------------------------------------
// Boundary conversions. Upstream sends at least four time formats:
//   CPA RFC3339 with 5-9 fractional digits and a local offset  2026-11-04T13:25:39.44912+01:00
//   header epoch seconds as strings                             "1793811600"
//   Anthropic RFC3339                                           2026-11-07T09:00:00Z
//   keeper text with a +08:00 offset, possibly space-separated  2026-11-04 20:04:26.66+08:00
// ---------------------------------------------------------------------------------------------

/** Parse any of the RFC3339 variants above. Returns null on garbage; callers decide whether that's an error. */
export function parseInstant(text: string | null | undefined): Instant | null {
  // TODO: normalize ' ' → 'T'; trim fractional seconds to 3 digits (JSC's Date.parse is strict
  // about >3 digits in some versions); Date.parse; NaN → null.
  throw new Error('not implemented');
}

export function epochSecondsToInstant(s: string | number | null | undefined): Instant | null {
  throw new Error('not implemented');
}

/** Header utilization is a 0..1 fraction ("0.17"); Anthropic `/usage` is already 0..100. */
export function fractionToPercent(f: string | number | null | undefined): Percent | null {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Source<T>: one feed and its freshness. This is the "how old is this?" answer for the UI.
// ---------------------------------------------------------------------------------------------

export interface Sample<T> {
  readonly value: T;
  /** When the upstream produced or we received this value. Freshness is measured from here. */
  readonly at: Instant;
}

/**
 * One feed, owned by exactly one writer.
 * Invariant: `error` is null or `error.at > last.at`; a success clears the error.
 * `nextAt` is when the owner will try again. It's null when nothing is scheduled, e.g. the link is down.
 */
export interface Source<T> {
  readonly last: Sample<T> | null;
  readonly error: Sample<SourceError> | null;
  readonly nextAt: Instant | null;
}

export type SourceError =
  | { readonly kind: 'rate_limited'; readonly retryAt: Instant }
  | { readonly kind: 'auth'; readonly status: number } // Anthropic said 401/403 for this account's token
  | { readonly kind: 'cpa_unreachable' }
  | { readonly kind: 'link_down' } // see LinkState; no request was sent
  | { readonly kind: 'upstream'; readonly status: number; readonly message: string }
  | { readonly kind: 'malformed'; readonly message: string };

// ---------------------------------------------------------------------------------------------
// CPA (writer: server/observer.ts, from server/cpa.ts parses)
// ---------------------------------------------------------------------------------------------

export type RoutingStrategy = 'fill-first' | 'round-robin';
export type CpaStatus = 'active' | 'error' | 'disabled' | 'pending' | 'refreshing' | 'unknown';
export type CooldownReason =
  | 'quota'
  | 'credential_quota'
  | 'unauthorized'
  | 'payment_required'
  | 'not_found'
  | 'invalid_grant'
  | 'cloudflare_challenge'
  | 'model_not_supported'
  | 'transient_error'
  | 'unknown';

export interface Cooldown {
  /** null = credential scope (blocks the whole account); string = that model only. */
  readonly model: string | null;
  readonly reason: CooldownReason;
  readonly retryAt: Instant;
  readonly httpStatus: number | null;
}

export type HeaderStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** One `Anthropic-Ratelimit-Unified-<key>-*` window from the passive header snapshot. */
export interface HeaderWindow {
  /** Header key segment: '5h' | '7d' | '7d_oi' | 'Overage' | ... Unknown keys are kept and shown. */
  readonly key: string;
  readonly percent: Percent | null;
  readonly resetsAt: Instant | null;
  readonly status: HeaderStatus | null;
}

/**
 * Passive quota: the headers of the last real response that CPA proxied on this account.
 * It's updated only by traffic, kept in CPA's memory, and lost when CPA restarts (then null).
 */
export interface HeaderQuota {
  readonly observedAt: Instant;
  readonly status: HeaderStatus | null;
  readonly windows: readonly HeaderWindow[];
  readonly overageDisabledReason: string | null;
  readonly representativeClaim: string | null;
  /** Per-model: when each model last got a response, and that response's unified status. */
  readonly models: readonly { readonly model: string; readonly observedAt: Instant; readonly status: HeaderStatus | null }[];
}

/** 10-minute activity bucket, anchored to absolute time at parse (CPA only sends "HH:MM-HH:MM"). */
export interface ActivityBucket {
  readonly start: Instant;
  readonly success: number;
  readonly failed: number;
}

/**
 * One Claude credential as CPA reports it. CPA's file `name` is NOT here. Only cpa.ts needs it,
 * for PATCH bodies, and it resolves AccountId → name privately. The UI and handlers speak AccountId only.
 */
export interface CpaAccount {
  readonly id: AccountId;
  readonly email: string;
  readonly disabled: boolean;
  readonly priority: number;
  readonly status: CpaStatus;
  /** `error.message` parsed out of CPA's raw `status_message` JSON string; the raw text if it isn't JSON. */
  readonly statusMessage: string | null;
  readonly unavailable: boolean;
  readonly nextRetryAfter: Instant | null;
  readonly cooldowns: readonly Cooldown[];
  readonly headers: HeaderQuota | null;
  readonly lastRefresh: Instant | null;
  /** 20 buckets, oldest first, contiguous. */
  readonly activity: readonly ActivityBucket[];
  /** Counters since CPA start. */
  readonly totals: { readonly success: number; readonly failed: number };
}

// ---------------------------------------------------------------------------------------------
// Anthropic (writer: server/observer.ts, from server/anthropic.ts parses)
// ---------------------------------------------------------------------------------------------

export type Severity = 'normal' | 'warning' | 'critical';

/** One entry of `/api/oauth/usage` `limits[]`. Unknown `kind`s pass through and render generically. */
export interface Limit {
  readonly kind: 'session' | 'weekly_all' | 'weekly_scoped' | (string & {});
  readonly group: 'session' | 'weekly' | (string & {});
  readonly percent: Percent;
  readonly severity: Severity;
  readonly resetsAt: Instant | null;
  /** `scope.model.display_name` for weekly_scoped limits, else null. */
  readonly scopeModel: string | null;
  /** The limit currently binding. */
  readonly isActive: boolean;
}

export interface Money {
  readonly minor: number;
  readonly currency: string;
  readonly exponent: number;
}

/** `spend` from `/api/oauth/usage` (extra usage). The legacy `extra_usage` key is ignored. */
export interface Spend {
  readonly enabled: boolean;
  readonly used: Money;
  readonly limit: Money | null;
  readonly percent: Percent | null;
  readonly severity: Severity;
  readonly disabledReason: string | null;
}

/** juniper_tide: the weekly session-limit reset. */
export interface JuniperTide {
  readonly eligible: boolean;
  readonly ineligibleReason: string | null;
  readonly inExperiment: boolean;
  readonly arm: string | null;
  readonly available: boolean;
  readonly nextAvailableAt: Instant | null;
  readonly weeklyResetsAt: Instant | null;
  readonly resetsPerWeek: number;
}

export interface Grant {
  readonly id: GrantId;
  readonly label: string;
  readonly type: 'session' | 'weekly' | 'full' | (string & {});
  readonly resetsTotal: number;
  readonly resetsLeft: number;
  readonly startsAt: Instant | null;
  readonly endsAt: Instant | null;
  /** Window names this grant clears, e.g. ['five_hour']. */
  readonly clears: readonly string[];
  readonly paused: boolean;
  readonly usableNow: boolean;
  readonly useRequiresLimit: boolean;
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
  readonly pausedHeld: boolean;
}

/** null program = the account is not in that program (upstream sent null). */
export interface ResetPrograms {
  readonly juniperTide: JuniperTide | null;
  readonly cedarEmber: CedarEmber | null;
}

export interface Profile {
  readonly email: string;
  readonly orgUuid: string;
  readonly orgName: string;
  readonly orgType: string; // claude_max | claude_team | ...
  readonly rateLimitTier: string; // default_claude_max_20x | default_claude_max_5x | ...
  readonly planLabel: string | null; // "Ultra plan"
  readonly subscriptionStatus: string | null;
}

/**
 * Anthropic feeds for one account, grouped by what they tell you, not by which endpoint they came from.
 * `limits` is written by BOTH the usage poll and the at-wall poll (both bodies carry limits[]);
 * the newer success wins. `spend` comes only from usage; `programs` only from at-wall.
 */
export interface AccountFeeds {
  readonly limits: Source<readonly Limit[]>;
  readonly spend: Source<Spend | null>;
  readonly programs: Source<ResetPrograms>;
  readonly profile: Source<Profile>;
}

// ---------------------------------------------------------------------------------------------
// Claims (writer: server/claims.ts, persisted in deck.db)
// ---------------------------------------------------------------------------------------------

export type ProgramId = 'juniper_tide' | 'cedar_ember';

/** Facts captured at prepare time. They're shown in the confirm dialog and used to resolve in_doubt. */
export interface Preflight {
  readonly programsAt: Instant;
  readonly available: boolean;
  readonly resetsLeft: number | null; // cedar grant only
  readonly nextAvailableAt: Instant | null;
  readonly clears: readonly string[];
}

export type ClaimResult =
  // Anthropic answered. The first one is the only result that consumed a reset.
  | { readonly result: 'reset'; readonly cleared: readonly string[]; readonly resetsLeft: number | null; readonly nextAvailableAt: Instant | null }
  | { readonly result: 'already_used' | 'not_limited' | 'cooldown' | 'ineligible' | 'unavailable'; readonly reason: string | null; readonly nextAvailableAt: Instant | null }
  | { readonly result: 'rate_limited' | 'auth_error'; readonly status: number }
  // Never reached Anthropic.
  | { readonly result: 'not_sent'; readonly why: string }
  // Resolved from in_doubt by comparing Preflight with a later at-wall poll.
  | { readonly result: 'inferred_consumed' | 'inferred_not_consumed'; readonly evidenceAt: Instant };

export type ClaimState =
  | { readonly kind: 'prepared'; readonly expiresAt: Instant }
  | { readonly kind: 'expired' }
  | { readonly kind: 'sending'; readonly sentAt: Instant }
  /** We crashed or timed out after the request may have left. Never resent automatically. */
  | { readonly kind: 'in_doubt'; readonly sentAt: Instant }
  | {
      readonly kind: 'settled';
      readonly outcome: ClaimResult;
      readonly settledAt: Instant;
      /** CPA `reset-quota` after `reset` or `not_limited`. Idempotent; retried until done. */
      readonly followup: 'not_needed' | 'pending' | 'done' | 'failed';
    };

export interface ClaimRecord {
  readonly id: ClaimId;
  readonly account: AccountId;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
  readonly createdAt: Instant;
  readonly preflight: Preflight;
  readonly state: ClaimState;
}

// ---------------------------------------------------------------------------------------------
// OAuth add-account flows (writer: server/oauth.ts, in memory)
// ---------------------------------------------------------------------------------------------

export interface OAuthFlow {
  readonly id: FlowId;
  readonly url: string;
  readonly startedAt: Instant;
  readonly status: 'waiting' | 'ok' | 'error' | 'expired' | 'cancelled';
  readonly error: string | null;
  /** Set once the new credential shows up in /auth-files. */
  readonly account: AccountId | null;
}

// ---------------------------------------------------------------------------------------------
// Link to CPA's management API (writer: server/cpa.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Anything but 'ok' means no management request will be sent. That covers every CPA call and every
 * Anthropic call, because those go through api-call.
 */
export type LinkState =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing_key'; readonly envPath: string }
  /** CPA answered 401/403. Latched until the env file changes; never retried with the same key. */
  | { readonly kind: 'rejected'; readonly at: Instant; readonly envPath: string }
  /** Our persisted lockout budget is spent (2 failures / 30 min). Unlocks at `until`. */
  | { readonly kind: 'guarded'; readonly until: Instant };

// ---------------------------------------------------------------------------------------------
// The snapshot. Assembled in server/http.ts by reading each owner. No owner writes another's part.
// ---------------------------------------------------------------------------------------------

export interface Snapshot {
  /** Increments on every change, in any part. */
  readonly version: number;
  readonly generatedAt: Instant;
  readonly link: LinkState; // cpa.ts
  readonly cpa: Source<readonly CpaAccount[]>; // observer.ts
  readonly strategy: Source<RoutingStrategy>; // observer.ts
  readonly feeds: Readonly<Record<AccountId, AccountFeeds>>; // observer.ts
  readonly claims: readonly ClaimRecord[]; // claims.ts: open ones plus the 20 most recent settled
  readonly flows: readonly OAuthFlow[]; // oauth.ts
}
