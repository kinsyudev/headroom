import type {
  AccountId,
  ClaimId,
  CooldownReason,
  CooldownScope,
  Effort,
  GrantId,
  Instant,
  LinkState,
  Money,
  OAuthFlow,
  Outcome,
  Percent,
  PercentLeft,
  ProgramId,
  RoutingStrategy,
  Severity,
  SourceError,
  TokenSums,
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
  readonly gloss: string | null;
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
  readonly order: ServeOrderView;
  readonly nextReset: { readonly account: AccountId; readonly email: string; readonly label: string; readonly at: Instant } | null;
  readonly claimable: readonly ClaimableView[];
  readonly claimableCount: number;
  /** Every open window whose pace says it runs out before it resets, soonest first. */
  readonly runningOut: readonly RunOutView[];
  /**
   * The soonest of them on an account serving now or taking the next session, with the account next in line after it;
   * null when none of those runs out.
   */
  readonly servingRunsOut: { readonly window: RunOutView; readonly next: { readonly account: AccountId; readonly email: string } | null } | null;
}

/** An open quota window on course to run out at `at`, before it resets at `resetsAt`, if the average burn since it opened holds. */
export interface RunOutView {
  readonly account: AccountId;
  readonly email: string;
  readonly limit: { readonly key: string; readonly label: string };
  readonly at: Instant;
  readonly resetsAt: Instant;
}

/** One account's claimable resets, named as the card and the claim dialog name them. detail: what is left of the grant. */
export interface ClaimableView {
  readonly account: AccountId;
  readonly email: string;
  readonly resets: readonly { readonly program: ProgramId; readonly grant: GrantId | null; readonly name: string; readonly detail: string | null }[];
}

export type ServingWhy = 'fill_first_target' | 'affinity' | 'round_robin';

/**
 * Every account in the order CPA's routing reaches it. In line: the accounts CPA can send to, highest priority first,
 * so rank 1 is where a new session lands. Then the blocked ones, soonest back first, then the disabled ones.
 * rotates: round-robin takes turns through the accounts in line, so their rank is only the order they are listed in.
 */
export interface ServeOrderView {
  readonly rotates: boolean;
  readonly lines: readonly ServeLine[];
}

/**
 * session and weekly are what the account's row draws as left; null where it has no reading of that window.
 * until: when a blocked account is back, said as the reset of the window holding it when that reset is what frees it, as its row says.
 */
export type ServeLine = { readonly account: AccountId; readonly email: string } & (
  | { readonly kind: 'in_line'; readonly rank: number; readonly session: PercentLeft | null; readonly weekly: PercentLeft | null }
  | { readonly kind: 'blocked'; readonly until: Instant | null; readonly reason: string }
  | { readonly kind: 'disabled' }
);

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
  /** Whether priority decides who serves first. Fill-first reads it, round-robin ignores it. */
  readonly ranksByPriority: boolean;
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

/**
 * What a meter's fill says, by status alone. warning: the window is on course to run out before it resets, or, with no
 * pace to project from, a quarter or less is left. critical: at the limit. Everything else is normal and draws neutral.
 */
export type MeterTone = Severity;

export interface LimitView {
  readonly key: string;
  readonly label: string;
  /** What the label leaves unsaid: a scoped weekly window counts only its model's requests ("Fable models only"). */
  readonly gloss: string | null;
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
  /** How fast this open window is being used, from its latest reading alone. Null unless the window is open with a known length and reset. */
  readonly pace: LimitPace | null;
}

export interface LimitPace {
  /** When the window opened: its reset less its length. */
  readonly startsAt: Instant;
  /** When the window resets. */
  readonly endsAt: Instant;
  /** The share of the window's time already gone, 0 to 100. */
  readonly elapsed: number;
  readonly used: Percent;
  /** used ÷ elapsed. 1 is even pace; above 1 the window runs out before it resets. Null while under 1% of the window is gone. */
  readonly ratio: number | null;
  /** Where the window would stand at its reset if the burn so far held: used ÷ elapsed × 100. Above 100 it runs out first. Null where ratio is. */
  readonly projected: number | null;
  readonly outlook: PaceOutlook;
}

/**
 * A straight line at the window's average burn since it opened. hits: it reaches the limit at `at`, before the reset.
 * too_early: under 5% of the window is gone, too little to project from.
 */
export type PaceOutlook =
  | { readonly kind: 'at_limit' }
  | { readonly kind: 'hits'; readonly at: Instant }
  | { readonly kind: 'lasts' }
  | { readonly kind: 'too_early' };

/** off: extra usage is disabled. no_budget: enabled with a cap of zero. cap_used: a cap above zero spent to its limit or past it. budget: a cap with room, or none set. */
export type SpendState = 'off' | 'no_budget' | 'cap_used' | 'budget';

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
  /** The reset's one name, from the card row and its Claim button to the claim dialog: its source ("Weekly reset"). */
  readonly name: string;
  /**
   * The standing terms that follow the name on the card row ("clears the session limit"), only when the account's
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

export const USAGE_RANGES = ['24h', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export type Grain = 'hour' | 'day';

/** How one chart looks at the usage history. Changing it never refetches; several charts may use different lenses at once. */
export interface AnalyticsLens {
  readonly range: UsageRange;
  /** Default: hour for 24h, day otherwise. */
  readonly grain?: Grain;
  /** Narrows every figure to one account, pace included. */
  readonly account?: AccountId;
  /** Narrows every figure to one model. Pace does not narrow, because a quota window counts every model. */
  readonly model?: string;
}

export interface AnalyticsView {
  readonly lens: { readonly range: UsageRange; readonly grain: Grain; readonly account: AccountId | null; readonly model: string | null };
  /** When the server read the history. Bucket edges and `partial` are judged against this, not the ticking clock. */
  readonly asOf: Instant;
  readonly keeperLatestAt: Instant | null;
  /** The server is still reading the history at startup, so the figures cover only part of it. */
  readonly catchingUp: boolean;
  /** From the first bucket's start to the last bucket's end, which runs past asOf. */
  readonly span: { readonly start: Instant; readonly end: Instant };
  readonly dimensions: AnalyticsDimensions;
  readonly total: UsageStats;
  /** The span one range earlier, so 24h meets the 24 hours before and 7d the 7 days before. Null for 30d, which the history cannot reach back far enough to match. */
  readonly previous: PriorSpan | null;
  /** Contiguous, zero-filled, browser-local buckets. Day buckets step by calendar date, so a DST day is 23 or 25 h. Only the last is partial. */
  readonly timeline: readonly TimeBucket[];
  /** Local weekday by hour of day over the span. */
  readonly week: WeekGrid;
  readonly byAccount: readonly Part<AccountId>[];
  readonly byModel: readonly Part<string>[];
  readonly byEffort: readonly Part<Effort>[];
  /** Every account and model pair with traffic in the span, most requests first. */
  readonly byAccountModel: readonly { readonly account: AccountId; readonly model: string; readonly stats: UsageStats }[];
  /** One row per open quota window per account in the lens. */
  readonly pace: readonly PaceView[];
  /** error_events inside the span that match the lens, newest first. */
  readonly errors: readonly ErrorEventView[];
}

/**
 * The order every breakdown follows, so one index means one series in every bucket. accounts: deck order, which keeps
 * colours stable. models: most requests in the span first. efforts: none, low, medium, high, xhigh, max, then values
 * keeper adds later, then '' (unset) last.
 */
export interface AnalyticsDimensions {
  readonly accounts: readonly { readonly id: AccountId; readonly email: string }[];
  readonly models: readonly string[];
  readonly efforts: readonly Effort[];
}

/**
 * What a span, or one of its buckets, is compared with: the same stretch of local calendar one range earlier, narrowed by the
 * same lens. The span still running is cut at asOf less that shift, so it meets as much of the earlier one as it has itself.
 * Cells count in whole hours, so the hour holding the cut counts in full. Null while the history does not reach back to the
 * start of the earlier span, or while the server is still reading it, because a short span would read as a drop.
 */
export interface PriorSpan {
  readonly start: Instant;
  readonly end: Instant;
  readonly stats: UsageStats;
}

/** Every figure a chart draws for one slice. Ratios are null where the denominator is zero. */
export interface UsageStats {
  /** The sum of outcomes, failed requests included. */
  readonly requests: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
  readonly rates: Readonly<Record<Outcome, number>> | null;
  readonly tokens: TokenSums;
  /** cacheRead ÷ (freshInput + cacheRead + cacheCreation). */
  readonly cacheReadShare: number | null;
  /** (freshInput + cacheCreation) ÷ the same input: what missed the cache, so it and cacheReadShare add to 1. */
  readonly cacheMissShare: number | null;
  readonly outputPerRequest: number | null;
  /** Sessions whose first request falls in this slice, so they add up across slices. */
  readonly sessions: number;
  readonly outputPerSession: number | null;
  /** Ok requests only, read from log-spaced bins: each value lies in the bin of the true one, within 19%. Null under 20 samples. */
  readonly latencyMs: Percentiles | null;
  readonly ttftMs: Percentiles | null;
}

export interface Percentiles {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly samples: number;
}

/** One series inside a parent slice. share: its fraction of the parent's requests and output; null when the parent has no requests. */
export interface Part<K> {
  readonly key: K;
  readonly stats: UsageStats;
  readonly share: { readonly requests: number; readonly output: number } | null;
}

export interface TimeBucket {
  readonly start: Instant;
  readonly end: Instant;
  /** The bucket that holds asOf, still filling. */
  readonly partial: boolean;
  readonly total: UsageStats;
  /** This bucket one range earlier, cut the way AnalyticsView.previous is; null where that is null. */
  readonly previous: PriorSpan | null;
  /** Aligned with dimensions.accounts, .models and .efforts, and zero-filled. */
  readonly byAccount: readonly Part<AccountId>[];
  readonly byModel: readonly Part<string>[];
  readonly byEffort: readonly Part<Effort>[];
}

/** 0 is Monday, in browser-local time. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface WeekGrid {
  /** rows[weekday][hour], always 7 by 24. */
  readonly rows: readonly (readonly WeekCell[])[];
  /** Requests on an average Monday, Tuesday and so on: each slot's mean per occurrence, summed over the day. */
  readonly perDay: readonly number[];
  /** Requests in an average hour of the day, over every weekday. */
  readonly perHour: readonly number[];
  /** The heaviest weekday and the heaviest three hours in a row, wrapping past midnight; null when the span has no requests. */
  readonly peak: { readonly weekday: Weekday; readonly hours: { readonly from: number; readonly to: number } } | null;
}

export interface WeekCell {
  readonly weekday: Weekday;
  /** Local hour of day, 0 to 23. */
  readonly hour: number;
  /** How many times this local slot has begun inside the span, so a chart can draw a mean per occurrence. */
  readonly occurrences: number;
  readonly stats: UsageStats;
}

/** Pace toward one open quota window, with what the window has cost so far. */
export interface PaceView {
  readonly account: AccountId;
  readonly email: string;
  readonly limit: { readonly key: string; readonly label: string };
  readonly pace: LimitPace;
  /** Usage on this account since the window opened, every model, counted in whole hours from the hour that holds startsAt. */
  readonly spent: UsageStats;
  /** spent ÷ used: what one percent of this window has cost. Null under 1% used. */
  readonly perPercent: { readonly requests: number; readonly output: number; readonly freshInput: number } | null;
}

export interface ErrorEventView {
  readonly id: number;
  readonly at: Instant | null;
  readonly account: AccountId | null;
  readonly email: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly outcome: Outcome | null;
  readonly quotaReason: string | null;
  readonly recoverAt: Instant | null;
  readonly message: string;
}
