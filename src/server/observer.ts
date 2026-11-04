/**
 * The observer is the single writer of everything the deck knows about the outside world: the CPA
 * account list, the routing strategy, and every account's Anthropic feeds (limits, spend, programs,
 * profile). Handlers and claims never write these. They ask the observer to look again
 * (`refreshCpa`, `kick`, `ensureFresh`).
 *
 * Polling policy (bounded, per the hard constraints):
 * - CPA /auth-files every 5 s, /routing/strategy every 60 s. Local, so no Anthropic cost.
 * - Anthropic calls go through ONE serial queue. At most one call is in flight, and calls are at
 *   least GLOBAL_GAP_MS apart, so startup with 3 accounts never bursts 9 calls.
 * - Each (account, endpoint) has a slot with its own cadence (`nextAttemptAt`, pure, below). No
 *   endpoint is polled more often than once per 60 s per account.
 * - A 429 or rate_limit_error backs off the whole account (all endpoints): 2 min × 2^streak,
 *   capped at 30 min, and never sooner than retry-after.
 * - Slots and backoff persist in deck.db, so a restart resumes the schedule instead of re-polling.
 * - A manual refresh only pulls `nextAt` earlier: debounced to 20 s per account, never past backoff.
 *
 * Feeds are grouped by information, not endpoint. Both usage and at_wall carry limits[], so
 * whichever succeeded last writes `limits`. That lets the at-wall poll stand in for the usage poll
 * near the wall, which halves the call rate exactly when rate limits bite.
 */
import type { AccountFeeds, AccountId, CpaAccount, Instant, Profile, ResetPrograms, Sample, Snapshot, Source } from '../shared/domain';
import type { Anthropic } from './anthropic';
import type { Cpa } from './cpa';
import type { PollSlotsTable } from './store';

export const CPA_EVERY_MS = 5_000;
export const STRATEGY_EVERY_MS = 60_000;
export const GLOBAL_GAP_MS = 5_000;
export const MIN_SLOT_GAP_MS = 60_000; // "about 60 s per account at most"
export const MANUAL_DEBOUNCE_MS = 20_000;
export const PROFILE_TTL_MS = 6 * 3_600_000;

export const CADENCE = {
  usage: { nearWall: 60_000, active: 2 * 60_000, idle: 10 * 60_000 },
  at_wall: { nearWall: 60_000, otherwise: 15 * 60_000 },
  profile: { ok: PROFILE_TTL_MS, failed: 15 * 60_000 },
  rateLimit: { base: 2 * 60_000, cap: 30 * 60_000 },
  failure: { base: 30_000, cap: 15 * 60_000 },
  /** Poll this long after a known boundary passes: a window's resetsAt, nextAvailableAt, or cooldownUntil. */
  afterBoundary: 10_000,
} as const;

export type Endpoint = 'usage' | 'at_wall' | 'profile';

export interface Observer {
  start(): void;
  stop(): void;
  /** The observer's part of the Snapshot. A new object on every change; never mutated in place. */
  state(): Pick<Snapshot, 'cpa' | 'strategy' | 'feeds'>;
  onChange(cb: () => void): () => void;
  /** Fires after every successful at-wall poll. claims.ts uses it to resolve in_doubt claims. */
  onPrograms(cb: (account: AccountId, programs: Sample<ResetPrograms>) => void): () => void;

  /** Fetch /auth-files (and strategy) now, and resolve once the new state is published. Used after every CPA mutation. */
  refreshCpa(): Promise<Instant>;
  /** Manual refresh. Returns when each account's next poll will actually run, and why it's held back if it is. */
  kick(account: AccountId | 'all'): readonly { account: AccountId; at: Instant; held: 'debounced' | 'rate_limited' | null }[];
  /**
   * For claim preflight. If programs are older than maxAgeMs, the account isn't rate-limited, and the
   * queue can take it within ~GLOBAL_GAP_MS, poll at-wall now and wait for it. Otherwise return what's cached.
   */
  ensureFresh(account: AccountId, feed: 'programs', maxAgeMs: number): Promise<Source<ResetPrograms>>;
  /** Cached profile, fetched if missing. Claims need orgUuid. Throws DeckError if unavailable. */
  profile(account: AccountId): Promise<Profile>;
  /** Mark an account as having an unresolved claim, so its at-wall slot gets the near-wall cadence. */
  setUrgent(account: AccountId, urgent: boolean): void;
}

export function createObserver(deps: {
  readonly cpa: Cpa;
  readonly anthropic: Anthropic;
  readonly slots: PollSlotsTable;
  readonly now: () => Instant;
}): Observer {
  // TODO:
  // load slots + backoff from deck.db → in-memory map; publish cached values as Source.last so the
  //   UI shows "limits 7m old" right after a restart instead of "never".
  // tick every 1 s (setTimeout chain, not setInterval, so a slow tick can't overlap):
  //   if cpa.link().kind !== 'ok' → mark all Sources error {link_down}, nextAt null; return
  //   CPA: if due and not in flight → listAccounts(); on success reconcile slots:
  //     new account → create slots with nextAt = now + index * GLOBAL_GAP_MS (stagger)
  //     vanished account → drop its slots and feeds
  //   Anthropic: if queue idle and now - lastCallAt >= GLOBAL_GAP_MS:
  //     slot = pickDue(slots, now)   (manual > urgent at_wall > boundary > oldest due)
  //     run(slot): call anthropic.{usage|atWall|profile}; write feeds; persist slot
  //       Polled.ok  → slot.streak = 0; feed.last = sample; feed.error = null
  //                    usage   → limits (if newer than limits.last) + spend
  //                    at_wall → limits (if newer) + programs; emit onPrograms
  //       rate_limited → account backoff: until = max(err.retryAt, now + min(cap, base * 2^streak)); persist
  //       other error → slot.streak++; feed.error = sample(error)
  //     slot.nextAt = nextAttemptAt(...)
  //   emit onChange if anything changed (the http hub debounces)
  throw new Error('not implemented');
}

/**
 * Pure cadence policy. All inputs are facts the observer already holds.
 *
 * TODO:
 * base =
 *   usage:   nearWall ? 60 s : active (traffic within 15 min) ? 2 min : 10 min
 *   at_wall: (nearWall || urgent) ? 60 s : 15 min
 *   profile: lastOk ? 6 h : 15 min
 * due = (lastAttemptAt ?? 0) + base
 * if lastFailed and not rate-limited: due = lastAttemptAt + min(failure.cap, failure.base * 2^streak)
 * if boundary && boundary > lastOkAt && boundary + afterBoundary < due: due = boundary + afterBoundary
 *     (Re-observe right after a window rolls or a reset unlocks, so 'rolled' and 'elapsed' states are short.)
 * if manualAt: due = min(due, max(manualAt, lastAttemptAt + MANUAL_DEBOUNCE_MS))
 * return max(due, rateLimitedUntil ?? 0, (lastAttemptAt ?? 0) + MIN_SLOT_GAP_MS)
 *     The MIN_SLOT_GAP_MS floor applies even to manual and boundary polls. Nothing beats 60 s per slot.
 */
export function nextAttemptAt(i: {
  readonly endpoint: Endpoint;
  readonly lastAttemptAt: Instant | null;
  readonly lastOkAt: Instant | null;
  readonly lastFailed: boolean;
  readonly streak: number;
  readonly nearWall: boolean;
  readonly active: boolean;
  readonly urgent: boolean;
  readonly boundary: Instant | null;
  readonly manualAt: Instant | null;
  readonly rateLimitedUntil: Instant | null;
}): Instant {
  throw new Error('not implemented');
}

/**
 * Earliest known future boundary for one account: any limit resetsAt, juniper nextAvailableAt,
 * cedar cooldownUntil, CPA cooldown retryAt. It feeds nextAttemptAt's `boundary`.
 */
export function nextBoundary(a: CpaAccount, feeds: AccountFeeds, after: Instant): Instant | null {
  throw new Error('not implemented');
}

export function emptyFeeds(): AccountFeeds {
  throw new Error('not implemented');
}

