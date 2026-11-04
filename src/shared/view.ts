/**
 * The output of `deriveDeck(snapshot, now)`. Components render from these types only and never
 * compute routing, availability or freshness themselves. A new fact a component needs goes here
 * and is computed in derive.ts.
 */
import type {
  AccountId,
  ClaimId,
  CooldownReason,
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
  /** Serving first, then priority descending, then email. */
  readonly accounts: readonly AccountView[];
  readonly banners: readonly Banner[];
  readonly flows: readonly OAuthFlow[];
  readonly strategy: RoutingStrategy | null;
  readonly global: readonly FreshnessView[];
}

export interface OverviewView {
  /** Accounts with a successful request in the last SERVING_WINDOW_MS. */
  readonly serving: readonly { readonly account: AccountId; readonly email: string; readonly why: ServingWhy; readonly lastAt: Instant }[];
  /** Where a new session lands under the current strategy. A prediction. */
  readonly target: { readonly account: AccountId; readonly email: string } | null;
  /** keeper when it is readable, else CPA's passive headers. */
  readonly servingEvidence: 'keeper' | 'cpa_headers';
  readonly headroom: { readonly session: Headroom; readonly weekly: Headroom };
  readonly nextReset: { readonly account: AccountId; readonly email: string; readonly label: string; readonly at: Instant } | null;
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

/**
 * Headroom summed over enabled accounts, in accounts' worth ("1.3 of 3").
 * session = sum of min(100 - session%, 100 - weekly%) / 100, since the weekly cap bounds the session.
 * weekly  = sum of (100 - weekly%) / 100. Accounts without data count in `unknown`.
 */
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
  readonly atWall: boolean;
  readonly limits: readonly LimitView[];
  readonly spend: SpendView | null;
  readonly offers: readonly OfferView[];
  readonly activity: readonly { readonly start: Instant; readonly success: number; readonly failed: number }[];
  readonly freshness: readonly FreshnessView[];
  readonly read: ReadView;
  /** What the UI may enable. Handlers enforce their own rules; this only greys out buttons. */
  readonly can: {
    readonly enable: boolean;
    readonly disable: boolean;
    readonly makePrimary: boolean;
    readonly clearCooldown: boolean;
  };
}

export interface ReadView {
  readonly nextAt: Instant | null;
  readonly reading: boolean;
  readonly backoffUntil: Instant | null;
  /** Why a manual refresh is refused right now, and until when. */
  readonly refreshHeld: { readonly why: 'rate_limited' | 'debounced' | 'reading'; readonly until: Instant | null } | null;
}

export interface PlanView {
  /** "Max 20x", "Team · Max 5x". */
  readonly label: string;
}

export interface RoutingView {
  readonly priority: number;
  readonly role:
    | { readonly kind: 'serving'; readonly why: ServingWhy }
    | { readonly kind: 'standby' }
    | { readonly kind: 'blocked'; readonly until: Instant | null; readonly reason: string }
    | { readonly kind: 'disabled' };
  /** In the tier a new session would land in. */
  readonly isTarget: boolean;
  /** Strictly higher priority than every other account, so Make primary has nothing to do. */
  readonly outranksAll: boolean;
  readonly lastSeenAt: Instant | null;
  readonly recent: number | null;
}

export interface CooldownView {
  readonly model: string | null;
  readonly reason: CooldownReason;
  readonly retryAt: Instant;
}

/**
 * open: a window is running and `percent` applies.
 * idle: the session limit is absent from limits[], so no session window is running.
 * lapsed: `resetsAt` has passed and nothing newer arrived; the old percent no longer applies.
 */
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
  /** The other source's value for the same window, drawn as a faint tick so disagreement shows. */
  readonly other: { readonly kind: 'poll' | 'headers'; readonly percent: Percent; readonly at: Instant } | null;
}

/** Extra usage. Wall reads skip spend, so an account at the wall may only have the header view. */
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
  /** Overage state from the passive headers, when they are newer than the poll. */
  readonly live: { readonly percent: Percent | null; readonly status: string | null; readonly reason: string | null; readonly at: Instant } | null;
}

export type OfferState =
  | { readonly kind: 'claimable'; readonly grant: GrantId | null }
  /** Evaluated at the wall, and the account isn't there. Not a "no". */
  | { readonly kind: 'held'; readonly lastAt: Instant | null; readonly lastClaimable: boolean }
  | { readonly kind: 'waiting'; readonly until: Instant | null }
  | { readonly kind: 'ineligible'; readonly reason: string; readonly explain: string }
  | { readonly kind: 'not_enrolled' }
  /**
   * A claim newer than the data: sending, its outcome unknown, or settled and waiting for a read
   * that shows the result. `result` is the settled outcome.
   */
  | { readonly kind: 'in_flight'; readonly claim: ClaimId; readonly phase: 'sending' | 'unknown' | 'confirming'; readonly result: string | null }
  | { readonly kind: 'unknown'; readonly why: 'never_read' | 'failing' };

export interface GrantView {
  readonly id: GrantId;
  readonly label: string;
  readonly resetsLeft: number;
  readonly resetsTotal: number;
  readonly endsAt: Instant | null;
  readonly clears: readonly string[];
  readonly usable: boolean;
}

export interface OfferView {
  readonly program: ProgramId;
  readonly label: string;
  /** What a successful claim does, in the operator's words. */
  readonly effect: string;
  readonly state: OfferState;
  readonly dataAt: Instant | null;
  readonly grants: readonly GrantView[];
}

export type FeedName = 'cpa' | 'strategy' | 'serving' | 'headers' | 'limits' | 'spend' | 'cedar' | 'juniper' | 'profile';

export interface FreshnessView {
  readonly feed: FeedName;
  /**
   * fresh / aging / stale use per-feed thresholds. `traffic` is for headers, whose age is the
   * last request rather than a failure. `held` is juniper away from the wall: not read on purpose.
   */
  readonly state: 'fresh' | 'aging' | 'stale' | 'failing' | 'never' | 'traffic' | 'held';
  readonly ageMs: number | null;
  readonly error: SourceError | null;
  readonly errorAgeMs: number | null;
  readonly nextAt: Instant | null;
}

export type Banner =
  | { readonly kind: 'link'; readonly link: Exclude<LinkState, { kind: 'ok' }>; readonly retryAt: Instant | null }
  | { readonly kind: 'cpa_unreachable'; readonly lastAt: Instant | null }
  | { readonly kind: 'claim_unknown'; readonly claim: ClaimId; readonly email: string; readonly program: ProgramId }
  | { readonly kind: 'keeper_unavailable'; readonly message: string };
