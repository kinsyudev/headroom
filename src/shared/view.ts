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
  PercentLeft,
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
  readonly status: StatusView;
  readonly cpa: CpaView;
  /** Every usage window any account reports, in display order: the columns of the accounts table. */
  readonly limitColumns: readonly LimitColumn[];
}

export interface LimitColumn {
  readonly key: string;
  readonly label: string;
}

export interface StatusView {
  readonly sources: readonly FreshnessView[];
  /** The sources that are not fresh, worst first. None means the page is live. */
  readonly problems: readonly FreshnessView[];
  /** Age of the newest reading across the sources; null until one has answered. */
  readonly newestAgeMs: number | null;
}

/** down: every action that goes through CPA is paused, and the CPA-sourced data on the page is as old as lastAt. */
export type CpaView = { readonly kind: 'up' } | { readonly kind: 'down'; readonly lastAt: Instant | null };

export interface OverviewView {
  /** Newest request first. takesNext: a new session would land on this account too. */
  readonly serving: readonly { readonly account: AccountId; readonly email: string; readonly why: ServingWhy; readonly lastAt: Instant; readonly takesNext: boolean }[];
  readonly target: { readonly account: AccountId; readonly email: string } | null;
  readonly servingEvidence: 'keeper' | 'cpa_headers';
  readonly room: RoomView;
  /** unblocks: the same account is blocked until within a minute of this reset, so the tile says it on the reset line. */
  readonly nextReset: { readonly account: AccountId; readonly email: string; readonly label: string; readonly at: Instant; readonly unblocks: boolean } | null;
  /** Null when nextReset already says it. */
  readonly nextUnblock: { readonly account: AccountId; readonly email: string; readonly at: Instant } | null;
  readonly claimable: readonly ClaimableView[];
  readonly claimableCount: number;
}

/** One account's claimable resets, named as the card and the claim dialog name them. detail: what is left of the grant. */
export interface ClaimableView {
  readonly account: AccountId;
  readonly email: string;
  readonly resets: readonly { readonly program: ProgramId; readonly grant: GrantId | null; readonly name: string; readonly detail: string | null }[];
}

export type ServingWhy = 'fill_first_target' | 'affinity' | 'round_robin';

/**
 * Where the room is. of: the enabled accounts. open: those CPA can send a request to now, neither blocked nor at a limit,
 * in the order traffic reaches them: the serving ones newest first, then by priority, so the account a new session would
 * land on comes next. session and weekly are what the account's row draws as left; null where it has no reading of that window.
 */
export interface RoomView {
  readonly of: number;
  readonly open: readonly { readonly account: AccountId; readonly email: string; readonly serving: boolean; readonly session: PercentLeft | null; readonly weekly: PercentLeft | null }[];
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
  /** What every reset clears ("the session limit") when they all clear the same limits, said once for all of them; null when they differ, so each row names its own. */
  readonly offersClear: string | null;
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
  /** CPA is not answering, and Anthropic reads go through it. */
  readonly paused: boolean;
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
  /** How far one press of − or + moves the priority, before the priority range clips it. */
  readonly step: number;
  /** The priority a step down or up sets; null where the step would change nothing. */
  readonly stepTo: { readonly down: number | null; readonly up: number | null };
  readonly role:
    | { readonly kind: 'serving'; readonly why: ServingWhy }
    | { readonly kind: 'standby' }
    | { readonly kind: 'blocked'; readonly until: Instant | null; readonly reason: string }
    | { readonly kind: 'disabled' };
  readonly isTarget: boolean;
  /** Fill-first's first in line on its own: enabled, not blocked, and above every other such account. Round-robin has no line. */
  readonly primary: boolean;
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
  /**
   * The usage window at its limit ("Session") when the cause is about quota, so the window is what holds
   * the account; null otherwise. liftsAt: that window's reset when every hold ends within a minute of it,
   * so the reset is what frees the account; null otherwise.
   */
  readonly limit: { readonly label: string; readonly liftsAt: Instant | null } | null;
}

/** idle: the session limit is absent from limits[], so no session window is running. */
export type WindowPhase = 'open' | 'idle' | 'lapsed';

/** How loudly a meter is drawn: its severity, except that a normal reading with most of its room left is 'ample' and recedes. */
export type MeterTone = Severity | 'ample';

export interface LimitView {
  readonly key: string;
  readonly label: string;
  readonly phase: WindowPhase;
  /** Used. What the wall and trouble are judged on; the page draws `left`. */
  readonly percent: Percent | null;
  /** Free: 100 for an idle window, null once the window has lapsed and no newer reading has arrived. */
  readonly left: PercentLeft | null;
  readonly severity: Severity;
  readonly tone: MeterTone;
  readonly resetsAt: Instant | null;
  /** Anthropic marks this window active and it is at warning or critical, so it is what holds the account back. */
  readonly limiting: boolean;
  readonly source: { readonly kind: 'poll' | 'headers'; readonly at: Instant };
  /** The reading that is not drawn. */
  readonly other: { readonly kind: 'poll' | 'headers'; readonly left: PercentLeft; readonly at: Instant } | null;
}

/** off: extra usage is disabled. no_budget: enabled with a cap of zero. budget: a cap above zero, or none set. */
export type SpendState = 'off' | 'no_budget' | 'budget';

export interface SpendView {
  readonly poll: {
    readonly state: SpendState;
    readonly used: Money;
    readonly limit: Money | null;
    readonly left: PercentLeft | null;
    /** The cap less what is spent, never below zero; null when there is no cap. */
    readonly remaining: Money | null;
    readonly severity: Severity;
    /** What the meter draws: critical when the live overage reading is, else the poll's own tone. */
    readonly tone: MeterTone;
    readonly disabledReason: string | null;
    readonly at: Instant;
  } | null;
  readonly live: {
    readonly left: PercentLeft | null;
    readonly status: string | null;
    readonly reason: string | null;
    readonly severity: Severity;
    /** When the overage window resets, if the headers said; null otherwise. */
    readonly resetsAt: Instant | null;
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
  /** The reset's one name, from the card row and its Claim button to the claim dialog: its source ("Weekly allowance"). */
  readonly name: string;
  /**
   * The standing terms that follow the name on the card row ("once a week"), with what it clears only when the account's
   * resets differ in that (see AccountView.offersClear). A grant's count and end come from grants.
   */
  readonly terms: readonly string[];
  readonly effect: string;
  /** When each limit the reset clears would reset without it; limits with no open window are left out. */
  readonly selfResets: readonly { readonly what: string; readonly at: Instant }[];
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
