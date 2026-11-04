/**
 * deriveDeck: the one place where facts become conclusions.
 *
 * Pure: no I/O, no Date.now(), no globals. Both sides run it:
 * - the browser, once a second, so countdowns, ages, rolled windows, and expired cooldowns stay
 *   live without server pushes;
 * - the server, to decide whether a claim is allowed (claims.ts), how to make an account primary
 *   (handlers.ts), and how fast to poll (observer.ts).
 * The UI and the server can't disagree about "claimable" because only this code decides it.
 *
 * Tests feed it fixture-derived Snapshots and a fixed `now` (test/derive.test.ts).
 */
import type {
  AccountFeeds,
  AccountId,
  CedarEmber,
  ClaimRecord,
  CpaAccount,
  HeaderQuota,
  Instant,
  JuniperTide,
  Limit,
  Profile,
  ProgramId,
  ResetPrograms,
  RoutingStrategy,
  Sample,
  Snapshot,
  Source,
  Spend,
} from './domain';
import type {
  AccountView,
  Banner,
  DeckView,
  FeedName,
  FreshnessView,
  Headroom,
  LimitView,
  OfferState,
  OfferView,
  OverviewView,
  PlanView,
  RoutingView,
  SpendView,
} from './view';

/** An account counts as "serving" if CPA saw an Anthropic response on it within this window. */
export const SERVING_WINDOW_MS = 120_000;

/** Per-feed thresholds: fresh below `aging`, aging below `stale`, stale above. */
export const FRESHNESS: Record<Exclude<FeedName, 'headers'>, { aging: number; stale: number }> = {
  cpa: { aging: 15_000, stale: 60_000 },
  limits: { aging: 3 * 60_000, stale: 15 * 60_000 },
  spend: { aging: 10 * 60_000, stale: 30 * 60_000 },
  programs: { aging: 5 * 60_000, stale: 30 * 60_000 },
  profile: { aging: 12 * 3_600_000, stale: 48 * 3_600_000 },
};

/** Any limit at or above this percent, or any quota cooldown, counts as "near the wall". Drives at-wall cadence. */
export const NEAR_WALL_PERCENT = 85;

/** Header window key → `limits[].kind`. Header keys not listed here have no poll counterpart and render header-only. */
const HEADER_TO_LIMIT_KIND: Readonly<Record<string, string>> = { '5h': 'session', '7d': 'weekly_all' };

/** Human explanation per ineligible_reason. Unknown reasons render verbatim. */
export const INELIGIBLE_EXPLAIN: Readonly<Record<string, string>> = {
  tier: 'Plan tier is not in the program.',
  tenure: 'Account is too new.',
  surface: 'Request did not look like Claude Code. This is a deck bug: User-Agent or x-app header missing.',
  mobile: 'Only offered on mobile.',
  cli_version: 'Claude Code version in the deck User-Agent is too old. Bump CLAUDE_CLI_VERSION in config.ts.',
  weekly_limit: 'Weekly limit is binding; a session reset would not help.',
  no_weekly_limit: 'Account has no weekly limit.',
  other_experiment: 'Enrolled in a different experiment.',
  control_arm: 'In the experiment, control arm: no reset offered.',
  no_grant: 'No reset grants on this account.',
  exhausted: 'All grants used.',
};

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function deriveDeck(s: Snapshot, now: Instant): DeckView {
  // TODO:
  // accounts = s.cpa.last?.value ?? []          (no CPA data → empty deck + cpa_unreachable banner)
  // routing  = deriveRouting(accounts, s.strategy.last?.value ?? null, now)
  // views    = accounts.map(a => deriveAccount(a, s.feeds[a.id] ?? EMPTY_FEEDS, routing.get(a.id)!, s.claims, now))
  // sort views: role serving first, then priority desc, then email
  // overview = deriveOverview(views, now)
  // banners  = link != ok → link banner; cpa.error && cpa.last older than stale → cpa_unreachable;
  //            each claim in in_doubt → claim_in_doubt
  throw new Error('not implemented');
}

export function deriveAccount(
  a: CpaAccount,
  feeds: AccountFeeds,
  routing: RoutingView,
  claims: readonly ClaimRecord[],
  now: Instant,
): AccountView {
  throw new Error('not implemented');
}

export function deriveOverview(accounts: readonly AccountView[], now: Instant): OverviewView {
  // TODO:
  // serving    = accounts with role.kind === 'serving', ordered by lastServedAt desc
  // target     = first account with routing.isTarget (ties: most recent lastServedAt, then email)
  // headroom   = see Headroom doc in view.ts; skip disabled accounts; rolled limits count as 0% used
  // nextReset  = min over accounts × limits of resetsAt where resetsAt > now
  // nextUnblock= min over blocked accounts of role.until
  // claimable  = flatten offers where state.kind === 'claimable'
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

/**
 * Who gets traffic.
 *
 * eligible(a) = !a.disabled
 *               && !(a.unavailable && (a.nextRetryAfter == null || a.nextRetryAfter > now))
 *               && no credential-scope cooldown with retryAt > now
 *   Time-correct between CPA polls: once nextRetryAfter or retryAt passes, the account becomes
 *   eligible on the next tick, without waiting for the next /auth-files read.
 *   `status` (e.g. 'error' with a spend-limit message) is shown, but it doesn't decide routing.
 *   CPA retries the account after nextRetryAfter whatever the status says.
 *   Model-scoped cooldowns don't make an account ineligible; they show on the card.
 *
 * fill-first: target tier = eligible accounts at max(priority). round-robin: every eligible account.
 * serving  = lastServedAt within SERVING_WINDOW_MS. Evidence beats prediction: an account outside
 *            the target tier that is still serving is labelled 'affinity'. The fixture shows exactly
 *            this, with the priority-10 account taking traffic while a priority-50 account is eligible.
 * lastServedAt = max(headers.observedAt, headers.models[].observedAt).
 * blocked.until = max(active credential cooldown retryAt, nextRetryAfter if unavailable); null if unavailable with no retry time.
 *
 * TODO: verify CPA's tie-break inside one fill-first tier (file order? auth_index?). Until then
 * isTarget is true for every account in the tier, and overview.target picks by recent evidence.
 */
export function deriveRouting(
  accounts: readonly CpaAccount[],
  strategy: RoutingStrategy | null,
  now: Instant,
): ReadonlyMap<AccountId, RoutingView> {
  throw new Error('not implemented');
}

/**
 * The plan behind "Make primary". It's idempotent: if `target` already outranks every other
 * account, the plan is a no-op, so a second click or a retry writes nothing.
 * New priority = max(other priorities) + 10. Other accounts are never touched.
 * Disabled targets are enabled as well, because a disabled primary routes nothing.
 */
export function planMakePrimary(
  accounts: readonly CpaAccount[],
  target: AccountId,
): { readonly priority: number | null; readonly enable: boolean } {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Limits: authoritative poll merged with passive headers
// ---------------------------------------------------------------------------------------------

/**
 * One row per window. Rows come from the poll's limits[]; the headers fill in or override.
 *
 * TODO:
 * rows = poll?.value.map(l => row(l, source = {poll, poll.at})) ?? []
 * for each header window w in headers?.windows:
 *   kind = HEADER_TO_LIMIT_KIND[w.key]
 *   if !kind or w.percent == null: skip ('Overage' is handled by deriveSpend; unknown keys skipped)
 *   row = rows.find(r => r.kind === kind && r.scopeModel == null)
 *   if !row: rows.push(row from header, source = {headers, headers.observedAt}); continue
 *   if headers.observedAt > row.source.at:
 *       // headers are newer: draw them, keep the poll value as `other`
 *       row.other = { poll, row.percent, row.source.at }; row.percent = w.percent; row.resetsAt = w.resetsAt ?? row.resetsAt
 *       row.severity = w.status === 'rejected' ? 'critical' : w.status === 'allowed_warning' ? 'warning' : row.severity
 *       row.source = { headers, headers.observedAt }
 *   else:
 *       row.other = { headers, w.percent, headers.observedAt }
 * for each row:
 *   rolled = row.resetsAt != null && row.resetsAt <= now   → percent = null, severity = 'normal'
 *   (A newer observation after the reset carries a new resetsAt, so rolled clears itself.)
 *   resetsInMs = resetsAt - now
 * order: session, weekly_all, weekly_scoped (by model), unknown kinds last
 */
export function mergeLimits(
  poll: Sample<readonly Limit[]> | null,
  headers: HeaderQuota | null,
  now: Instant,
): LimitView[] {
  throw new Error('not implemented');
}

export function deriveSpend(spend: Source<Spend | null>, headers: HeaderQuota | null): SpendView | null {
  throw new Error('not implemented');
}

export function derivePlan(profile: Source<Profile>): PlanView | null {
  // TODO: 'default_claude_max_20x' → 'Max 20x'; orgType 'claude_team' → prefix 'Team · '.
  throw new Error('not implemented');
}

/** Used by observer.ts to choose the at-wall cadence. */
export function isNearWall(a: CpaAccount, feeds: AccountFeeds, now: Instant): boolean {
  // TODO: any merged limit percent >= NEAR_WALL_PERCENT and not rolled
  //       || any cooldown with reason quota|credential_quota and retryAt > now
  //       || headers.status === 'rejected'
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Reset offers: the availability derivation
// ---------------------------------------------------------------------------------------------

/**
 * Both programs for one account. The server uses this for claim preflight, the UI for the card.
 * `open` = this account's claims in state sending or in_doubt. Any open claim turns its program
 * into in_flight, whatever the poll says.
 */
export function deriveOffers(
  programs: Source<ResetPrograms>,
  open: readonly ClaimRecord[],
  now: Instant,
): OfferView[] {
  // TODO:
  // if programs.last == null → both offers { unknown: programs.error ? 'failing' : 'never_polled' }
  // juniper = { program: 'juniper_tide', state: juniperState(p.juniperTide, openFor('juniper_tide'), now), ... }
  // cedar   = { program: 'cedar_ember',  state: cedarState(p.cedarEmber, openFor('cedar_ember'), now), grants, defaultGrant, ... }
  throw new Error('not implemented');
}

/**
 * juniper_tide: claimable iff eligible && arm === 'reset' && available.
 *
 * TODO:
 * if open → in_flight { claim: open.id, doubt: open.state.kind === 'in_doubt' }
 * if j === null → not_enrolled
 * if j.eligible:
 *   if j.arm !== 'reset' → ineligible('control_arm')
 *   if j.available → claimable { grant: null }
 *   → waiting { until: j.nextAvailableAt, elapsed: j.nextAvailableAt != null && j.nextAvailableAt <= now }
 *     (elapsed: the data predates the unlock; observer polls at nextAvailableAt + 10 s)
 * not eligible:
 *   'not_at_wall' → held('Checked when this account hits its session limit.')
 *     The fixture shows in_experiment=false and arm=null in this case, so "not at the wall" is all we know.
 *   other → ineligible(reason ?? 'unknown', INELIGIBLE_EXPLAIN[reason] ?? reason)
 */
export function juniperState(j: JuniperTide | null, open: ClaimRecord | undefined, now: Instant): OfferState {
  throw new Error('not implemented');
}

/**
 * cedar_ember: a grant is usable iff eligible && resetsLeft > 0 && !paused && usableNow.
 *
 * TODO:
 * if open → in_flight
 * if c === null → not_enrolled
 * if !c.eligible:
 *   reason 'no_grant' → not_enrolled-like ineligible('no_grant')
 *   any grant with resetsLeft > 0 && useRequiresLimit && !c.atLimit → held('Usable once this account is at a limit.')
 *   else ineligible(reason)
 * if c.cooldownUntil && c.cooldownUntil > now → waiting { until: c.cooldownUntil }
 * usable = c.grants.filter(g => g.resetsLeft > 0 && !g.paused && g.usableNow)
 * if usable.length === 0:
 *   all grants resetsLeft === 0 → ineligible('exhausted')
 *   some paused → waiting { until: null }
 *   else held(...)
 * default = usable.find(g => g.id === c.nextGrantId) ?? usable[0]
 * → claimable { grant: default.id }
 */
export function cedarState(c: CedarEmber | null, open: ClaimRecord | undefined, now: Instant): OfferState {
  throw new Error('not implemented');
}

/** One-line reason for a non-claimable offer, for errors thrown by claim.prepare. */
export function explainOffer(o: OfferView | undefined): string {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------------------------

/**
 * TODO:
 * last == null → error ? 'failing' : 'never'
 * error (newer than last by Source invariant) → 'failing' (ageMs still from last.at, so the UI says "41m old, failing")
 * else ageMs < aging → fresh; < stale → aging; else stale
 */
export function freshness<T>(feed: Exclude<FeedName, 'headers'>, src: Source<T>, now: Instant): FreshnessView {
  throw new Error('not implemented');
}

export function headerFreshness(headers: HeaderQuota | null, now: Instant): FreshnessView {
  throw new Error('not implemented');
}

/** Helper for claims.ts and the UI: the open claim (sending | in_doubt) for one account and program. */
export function openClaim(claims: readonly ClaimRecord[], account: AccountId, program: ProgramId): ClaimRecord | undefined {
  throw new Error('not implemented');
}
