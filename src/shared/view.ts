import type {
  AccountId,
  ClaimId,
  CooldownReason,
  CooldownScope,
  GrantId,
  Instant,
  LinkState,
  Money,
  OAuthFlow,
  Percent,
  ProgramId,
  RoutingStrategy,
  Severity,
  SourceError,
} from './domain';

export interface DeckView {
  readonly now: Instant;
  readonly overview: OverviewView;
  readonly accounts: readonly AccountView[];
  readonly banners: readonly Banner[];
  readonly flows: readonly OAuthFlow[];
  readonly strategy: RoutingStrategy | null;
  readonly global: readonly FreshnessView[];
  readonly cpa: CpaView;
}

/** down: every action that goes through CPA is paused, and the CPA-sourced data on the page is as old as lastAt. */
export type CpaView = { readonly kind: 'up' } | { readonly kind: 'down'; readonly lastAt: Instant | null };

export interface OverviewView {
  readonly serving: readonly { readonly account: AccountId; readonly email: string; readonly why: ServingWhy; readonly lastAt: Instant }[];
  readonly target: { readonly account: AccountId; readonly email: string } | null;
  readonly servingEvidence: 'keeper' | 'cpa_headers';
  readonly headroom: { readonly session: Headroom; readonly weekly: Headroom };
  /** unblocks: the same account is blocked until within a minute of this reset, so the tile says it on the reset line. */
  readonly nextReset: { readonly account: AccountId; readonly email: string; readonly label: string; readonly at: Instant; readonly unblocks: boolean } | null;
  /** Null when nextReset already says it. */
  readonly nextUnblock: { readonly account: AccountId; readonly email: string; readonly at: Instant } | null;
  readonly claimable: readonly ClaimableView[];
}

export interface ClaimableView {
  readonly account: AccountId;
  readonly email: string;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
  readonly label: string;
}

export type ServingWhy = 'fill_first_target' | 'affinity' | 'round_robin';

export interface Headroom {
  readonly value: number;
  readonly of: number;
  readonly unknown: number;
}

export interface AccountView {
  readonly id: AccountId;
  readonly email: string;
  readonly plan: PlanView | null;
  readonly routing: RoutingView;
  readonly cooldowns: readonly CooldownView[];
  readonly statusMessage: string | null;
  readonly trouble: TroubleView | null;
  readonly atWall: boolean;
  readonly limits: readonly LimitView[];
  readonly spend: SpendView | null;
  readonly offers: readonly OfferView[];
  /** Phrases for one line standing in for the offers when none is claimable, waiting, in flight or unreadable; null when any is. */
  readonly quietOffers: readonly string[] | null;
  readonly activity: readonly { readonly start: Instant; readonly success: number; readonly failed: number }[];
  readonly freshness: readonly FreshnessView[];
  readonly read: ReadView;
  readonly can: {
    readonly enable: boolean;
    readonly disable: boolean;
    readonly makePrimary: boolean;
    readonly clearCooldown: boolean;
  };
}

export interface ReadView {
  /** The freshest successful Anthropic usage read: limits, spend, grants or weekly reset. */
  readonly lastAt: Instant | null;
  readonly nextAt: Instant | null;
  readonly reading: boolean;
  readonly backoffUntil: Instant | null;
  readonly capUntil: Instant | null;
  readonly refreshHeld: { readonly why: 'rate_limited' | 'capped' | 'debounced' | 'reading'; readonly until: Instant | null } | null;
}

export interface PlanView {
  /** "Max 20x", "Team · Max 5x". */
  readonly label: string;
}

export interface RoutingView {
  readonly priority: number;
  /** The priority a step down or up sets; null where the step would change nothing. */
  readonly stepTo: { readonly down: number | null; readonly up: number | null };
  readonly role:
    | { readonly kind: 'serving'; readonly why: ServingWhy }
    | { readonly kind: 'standby' }
    | { readonly kind: 'blocked'; readonly until: Instant | null; readonly reason: string }
    | { readonly kind: 'disabled' };
  readonly isTarget: boolean;
  readonly outranksAll: boolean;
  readonly lastSeenAt: Instant | null;
  readonly recent: number | null;
}

export type CooldownView = CooldownScope & {
  readonly reason: CooldownReason;
  readonly retryAt: Instant;
};

/**
 * Why the account is in trouble, as the parts of one sentence. `cause` is CPA's message where it
 * maps to a known phrase, else the cooldown reason. A hold is one stretch of cooling down, and a
 * second appears only when the model cooldowns outlast the account's. `until` is null when CPA
 * gives no retry time. No holds means only CPA's last error message is left.
 */
export interface TroubleView {
  readonly cause: string;
  readonly holds: readonly { readonly what: string; readonly until: Instant | null }[];
}

/** idle: the session limit is absent from limits[], so no session window is running. */
export type WindowPhase = 'open' | 'idle' | 'lapsed';

export interface LimitView {
  readonly key: string;
  readonly label: string;
  readonly phase: WindowPhase;
  readonly percent: Percent | null;
  readonly severity: Severity;
  readonly resetsAt: Instant | null;
  readonly isActive: boolean;
  readonly source: { readonly kind: 'poll' | 'headers'; readonly at: Instant };
  readonly other: { readonly kind: 'poll' | 'headers'; readonly percent: Percent; readonly at: Instant } | null;
}

export interface SpendView {
  readonly poll: {
    readonly enabled: boolean;
    readonly used: Money;
    readonly limit: Money | null;
    readonly percent: Percent | null;
    readonly severity: Severity;
    readonly disabledReason: string | null;
    readonly at: Instant;
  } | null;
  readonly live: {
    readonly percent: Percent | null;
    readonly status: string | null;
    readonly reason: string | null;
    readonly severity: Severity;
    readonly at: Instant;
  } | null;
}

export type OfferState =
  | { readonly kind: 'claimable'; readonly grant: GrantId | null }
  | { readonly kind: 'held'; readonly lastAt: Instant | null; readonly lastClaimable: boolean }
  | { readonly kind: 'waiting'; readonly until: Instant | null }
  | { readonly kind: 'ineligible'; readonly reason: string; readonly explain: string }
  | { readonly kind: 'not_enrolled' }
  | { readonly kind: 'in_flight'; readonly claim: ClaimId; readonly phase: 'sending' | 'maybe_sent' | 'confirming'; readonly result: string | null }
  | { readonly kind: 'unknown'; readonly why: 'never_read' | 'failing' };

export interface GrantView {
  readonly id: GrantId;
  readonly label: string;
  readonly resetsLeft: number;
  readonly resetsTotal: number;
  readonly endsAt: Instant | null;
  readonly clears: readonly string[];
  readonly clearsText: string;
  readonly usable: boolean;
}

export interface OfferView {
  readonly program: ProgramId;
  readonly label: string;
  readonly effect: string;
  readonly state: OfferState;
  readonly dataAt: Instant | null;
  readonly grants: readonly GrantView[];
}

export type FeedName = 'cpa' | 'strategy' | 'serving' | 'headers' | 'limits' | 'spend' | 'cedar' | 'juniper' | 'profile';

export interface FreshnessView {
  readonly feed: FeedName;
  readonly state: 'fresh' | 'aging' | 'stale' | 'failing' | 'never' | 'traffic' | 'held';
  readonly ageMs: number | null;
  readonly error: SourceError | null;
  readonly errorAgeMs: number | null;
  readonly nextAt: Instant | null;
}

export type Banner =
  | { readonly kind: 'link'; readonly link: Exclude<LinkState, { kind: 'ok' }>; readonly retryAt: Instant | null }
  | { readonly kind: 'cpa_unreachable'; readonly lastAt: Instant | null }
  | { readonly kind: 'claim_unknown'; readonly claim: ClaimId; readonly email: string; readonly program: ProgramId; readonly label: string }
  | { readonly kind: 'keeper_unavailable'; readonly message: string };
