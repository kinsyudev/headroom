/**
 * DeckView is the output of `deriveDeck(snapshot, now)`. UI components render from these types
 * only. They never read `Snapshot` and never compute routing, availability, or freshness
 * themselves. If a component needs a new fact, add it here and compute it in derive.ts.
 *
 * Every field is either copied from a fact or computed from facts and `now`. Nothing here is
 * stored or sent over the wire.
 */
import type {
  AccountId,
  ClaimId,
  ClaimRecord,
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
  /** Ordered: serving first, then by priority (descending), then by email. */
  readonly accounts: readonly AccountView[];
  readonly banners: readonly Banner[];
  readonly flows: readonly OAuthFlow[];
  readonly strategy: RoutingStrategy | null;
}

// ---------------------------------------------------------------------------------------------
// Overview strip
// ---------------------------------------------------------------------------------------------

export interface OverviewView {
  /** Accounts with an Anthropic response in the last SERVING_WINDOW. Can be empty or several (affinity, round-robin). */
  readonly serving: readonly { readonly account: AccountId; readonly email: string; readonly why: ServingWhy; readonly lastAt: Instant }[];
  /** Predicted target for a new session under the current strategy. null when nothing is eligible. */
  readonly target: { readonly account: AccountId; readonly email: string } | null;
  readonly headroom: { readonly session: Headroom; readonly weekly: Headroom };
  /** Earliest future resetsAt across all accounts and limits. */
  readonly nextReset: { readonly account: AccountId; readonly email: string; readonly label: string; readonly at: Instant } | null;
  /** Earliest moment a currently blocked account becomes routable again. */
  readonly nextUnblock: { readonly account: AccountId; readonly email: string; readonly at: Instant } | null;
  readonly claimable: readonly { readonly account: AccountId; readonly email: string; readonly program: ProgramId; readonly grant: GrantId | null; readonly label: string }[];
}

export type ServingWhy = 'fill_first_target' | 'affinity' | 'round_robin';

/**
 * Headroom summed over enabled accounts, in "accounts' worth": 1.3 of 3.
 * session = Σ min(100 - session%, 100 - weekly_all%) / 100, because the weekly cap also bounds the session.
 * weekly  = Σ (100 - weekly_all%) / 100.
 * Accounts with no data at all are counted in `unknown`, not guessed.
 */
export interface Headroom {
  readonly value: number;
  readonly of: number;
  readonly unknown: number;
}

// ---------------------------------------------------------------------------------------------
// Account card
// ---------------------------------------------------------------------------------------------

export interface AccountView {
  readonly id: AccountId;
  readonly email: string;
  readonly plan: PlanView | null;
  readonly routing: RoutingView;
  readonly cooldowns: readonly CooldownView[];
  readonly statusMessage: string | null;
  readonly limits: readonly LimitView[];
  readonly spend: SpendView | null;
  readonly offers: readonly OfferView[];
  readonly activity: readonly { readonly start: Instant; readonly success: number; readonly failed: number }[];
  readonly freshness: readonly FreshnessView[];
  readonly claims: readonly ClaimRecord[];
  /** What the UI may enable. The handlers enforce the same rules; this only greys out buttons. */
  readonly can: {
    readonly enable: boolean;
    readonly disable: boolean;
    readonly makePrimary: boolean;
    readonly clearCooldown: boolean;
    readonly refreshToken: boolean;
    readonly refreshQuota: boolean;
  };
}

export interface PlanView {
  /** "Max 20x", "Team · Max 5x". */
  readonly label: string;
  readonly orgType: string;
  readonly tier: string;
  readonly planLabel: string | null;
}

export interface RoutingView {
  readonly priority: number;
  readonly role:
    | { readonly kind: 'serving'; readonly why: ServingWhy }
    | { readonly kind: 'standby' } // eligible, not receiving traffic
    | { readonly kind: 'blocked'; readonly until: Instant | null; readonly reason: string }
    | { readonly kind: 'disabled' };
  /** In the highest eligible priority tier, so a new session would land here under fill-first. */
  readonly isTarget: boolean;
  readonly lastServedAt: Instant | null;
}

export interface CooldownView {
  readonly model: string | null;
  readonly reason: CooldownReason;
  readonly retryAt: Instant;
  readonly remainingMs: number;
}

export interface LimitView {
  readonly key: string; // stable React key: kind + scopeModel
  readonly label: string; // "Session", "Weekly", "Opus weekly"
  readonly percent: Percent | null; // null while rolled and not yet re-observed
  readonly severity: Severity;
  readonly resetsAt: Instant | null;
  readonly resetsInMs: number | null;
  readonly isActive: boolean;
  /** resetsAt has passed and no newer observation exists. The old percent no longer applies. */
  readonly rolled: boolean;
  /** Which source the drawn percent came from, and how old it is. */
  readonly source: { readonly kind: 'poll' | 'headers'; readonly at: Instant };
  /** The other source's value for the same window, if any. Drawn as a faint tick so disagreement shows. */
  readonly other: { readonly kind: 'poll' | 'headers'; readonly percent: Percent; readonly at: Instant } | null;
}

export interface SpendView {
  readonly enabled: boolean;
  readonly used: Money;
  readonly limit: Money | null;
  readonly percent: Percent | null;
  readonly severity: Severity;
  readonly disabledReason: string | null;
  /** Live overage hint from headers (e.g. 101% rejected) when newer than the poll. */
  readonly live: { readonly percent: Percent | null; readonly status: string | null; readonly at: Instant } | null;
}

// ---------------------------------------------------------------------------------------------
// Reset offers
// ---------------------------------------------------------------------------------------------

export type OfferState =
  | { readonly kind: 'claimable'; readonly grant: GrantId | null }
  /** The program is evaluated at the wall, and the account isn't at it. Not a "no". */
  | { readonly kind: 'held'; readonly note: string }
  | { readonly kind: 'waiting'; readonly until: Instant | null; readonly elapsed: boolean }
  | { readonly kind: 'ineligible'; readonly reason: string; readonly explain: string }
  | { readonly kind: 'not_enrolled' }
  | { readonly kind: 'in_flight'; readonly claim: ClaimId; readonly doubt: boolean }
  | { readonly kind: 'unknown'; readonly why: 'never_polled' | 'failing' };

export interface GrantView {
  readonly id: GrantId;
  readonly label: string;
  readonly type: string;
  readonly resetsLeft: number;
  readonly resetsTotal: number;
  readonly endsAt: Instant | null;
  readonly clears: readonly string[];
  readonly usable: boolean;
  readonly paused: boolean;
}

export type OfferView =
  | {
      readonly program: 'juniper_tide';
      readonly label: string;
      readonly state: OfferState;
      readonly weeklyResetsAt: Instant | null;
      readonly dataAt: Instant | null;
    }
  | {
      readonly program: 'cedar_ember';
      readonly label: string;
      readonly state: OfferState;
      readonly grants: readonly GrantView[];
      readonly defaultGrant: GrantId | null;
      readonly cooldownUntil: Instant | null;
      readonly dataAt: Instant | null;
    };

// ---------------------------------------------------------------------------------------------
// Freshness and banners
// ---------------------------------------------------------------------------------------------

export type FeedName = 'cpa' | 'headers' | 'limits' | 'spend' | 'programs' | 'profile';

export interface FreshnessView {
  readonly feed: FeedName;
  /**
   * fresh / aging / stale use per-feed thresholds (derive.ts FRESHNESS). `traffic` is for headers:
   * their age reflects the last request, not a polling failure, so they never go "stale".
   */
  readonly state: 'fresh' | 'aging' | 'stale' | 'failing' | 'never' | 'traffic';
  readonly ageMs: number | null;
  readonly nextAt: Instant | null;
  readonly error: SourceError | null;
}

export type Banner =
  | { readonly kind: 'link'; readonly link: Exclude<LinkState, { kind: 'ok' }> }
  | { readonly kind: 'cpa_unreachable'; readonly sinceMs: number }
  | { readonly kind: 'claim_in_doubt'; readonly claim: ClaimId; readonly account: AccountId; readonly program: ProgramId };
