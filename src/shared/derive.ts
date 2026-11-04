import {
  emptyFeeds,
  type AccountFeeds,
  type AccountId,
  type CedarEmber,
  type ClaimRecord,
  type CpaAccount,
  type Grant,
  type HeaderQuota,
  type HeaderWindow,
  type Instant,
  type JuniperTide,
  type Limit,
  type Percent,
  type Profile,
  type ProgramId,
  type RoutingStrategy,
  type Sample,
  type Severity,
  type Snapshot,
  type Source,
  type Spend,
} from './domain';
import type {
  AccountView,
  Banner,
  ClaimableView,
  DeckView,
  FeedName,
  FreshnessView,
  Headroom,
  LimitView,
  OfferState,
  OfferView,
  OverviewView,
  PlanView,
  ReadView,
  RoutingView,
  SpendView,
} from './view';

export const SERVING_WINDOW_MS = 120_000;
export const NORMAL_READ_EVERY_MS = 5 * 60_000;
export const WALL_READ_EVERY_MS = 3 * 60_000;
export const PROFILE_READ_EVERY_MS = 6 * 3_600_000;
export const MANUAL_REFRESH_EVERY_MS = 60_000;
/** One rejected key per 35 min can never reach CPA's 5-strikes-in-30-min ban. */
export const KEY_REJECT_LATCH_MS = 35 * 60_000;
export const CLAUDE_CODE_CLAIM_TIMEOUT_MS = 25_000;
const MINUTE_MS = 60_000;
export const SETTLE_LAG_MS = Math.max(MINUTE_MS, 2 * CLAUDE_CODE_CLAIM_TIMEOUT_MS);

const FRESHNESS: Record<Exclude<FeedName, 'headers'>, { readonly aging: number; readonly stale: number }> = {
  cpa: { aging: 15_000, stale: 60_000 },
  strategy: { aging: 90_000, stale: 5 * 60_000 },
  serving: { aging: 15_000, stale: 60_000 },
  limits: { aging: NORMAL_READ_EVERY_MS + 60_000, stale: 3 * NORMAL_READ_EVERY_MS + 60_000 },
  spend: { aging: NORMAL_READ_EVERY_MS + 60_000, stale: 3 * NORMAL_READ_EVERY_MS + 60_000 },
  cedar: { aging: NORMAL_READ_EVERY_MS + 60_000, stale: 3 * NORMAL_READ_EVERY_MS + 60_000 },
  juniper: { aging: WALL_READ_EVERY_MS + 60_000, stale: 3 * WALL_READ_EVERY_MS + 60_000 },
  profile: { aging: PROFILE_READ_EVERY_MS + 3_600_000, stale: 4 * PROFILE_READ_EVERY_MS },
};

const HEADER_TO_KIND: Readonly<Record<string, 'session' | 'weekly_all'>> = { '5h': 'session', '7d': 'weekly_all' };
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped'];

export const INELIGIBLE_EXPLAIN: Readonly<Record<string, string>> = {
  tier: 'Plan tier is not in the program.',
  tenure: 'Account is too new.',
  surface: 'Request did not look like Claude Code. The deck sent the wrong User-Agent or x-app header.',
  mobile: 'Only offered on mobile.',
  cli_version: 'The Claude Code version the deck reports is too old.',
  not_at_wall: 'Anthropic says this account is not at a limit right now.',
  weekly_limit: 'The weekly limit is binding, so a session reset would not help.',
  no_weekly_limit: 'Account has no weekly limit.',
  other_experiment: 'Enrolled in a different experiment.',
  control_arm: 'In the experiment, but in the arm that is not offered resets.',
  no_grant: 'No reset grants on this account.',
  exhausted: 'Every grant is used up.',
  not_usable_now: 'No grant is usable right now.',
};

const WINDOW_WORDS: Readonly<Record<string, string>> = {
  five_hour: 'the session (5h) limit',
  seven_day: 'the weekly limit',
};

export function deriveDeck(s: Snapshot, now: Instant): DeckView {
  const accounts = s.cpa.last?.value ?? [];
  const evidence = servingEvidence(s, accounts);
  const routing = deriveRouting(accounts, s.strategy.last?.value ?? null, evidence.seen, now);
  const views = accounts
    .map((a) => deriveAccount(a, s.feeds[a.id] ?? emptyFeeds(), routing.get(a.id)!, s.claims, now))
    .sort((x, y) => x.email.localeCompare(y.email));
  return {
    now,
    overview: deriveOverview(views, evidence.kind),
    accounts: views,
    banners: deriveBanners(s, views),
    flows: s.flows,
    strategy: s.strategy.last?.value ?? null,
    global: [freshness('cpa', s.cpa, now), freshness('strategy', s.strategy, now), freshness('serving', s.serving, now)],
  };
}

export function deriveAccount(
  a: CpaAccount,
  feeds: AccountFeeds,
  routing: RoutingView,
  claims: readonly ClaimRecord[],
  now: Instant,
): AccountView {
  const limits = mergeLimits(feeds.limits.last, a.headers, now);
  const atWall = isAtWall(a, feeds.limits.last, now);
  const mine = claims.filter((c) => c.account === a.id);
  const read = deriveRead(feeds, now);
  return {
    id: a.id,
    email: a.email,
    plan: derivePlan(feeds.profile),
    routing,
    cooldowns: a.cooldowns.filter((c) => c.retryAt > now).map(({ model, reason, retryAt }) => ({ model, reason, retryAt })),
    statusMessage: a.statusMessage,
    atWall,
    limits,
    spend: deriveSpend(feeds.spend, a.headers),
    offers: deriveOffers(a.id, feeds, atWall, mine, now),
    activity: a.activity,
    freshness: [
      headerFreshness(a.headers, now),
      freshness('limits', feeds.limits, now),
      freshness('spend', feeds.spend, now, atWall),
      freshness('cedar', feeds.cedar, now),
      freshness('juniper', feeds.juniper, now, !atWall),
      freshness('profile', feeds.profile, now),
    ],
    read,
    can: {
      enable: a.disabled,
      disable: !a.disabled,
      makePrimary: a.disabled || !routing.outranksAll,
      clearCooldown: a.cooldowns.some((c) => c.retryAt > now) || (a.unavailable && (a.nextRetryAfter ?? Infinity) > now),
    },
  };
}

export function isAtWall(a: CpaAccount | undefined, limits: Sample<readonly Limit[]> | null, now: Instant): boolean {
  const rows = mergeLimits(limits, a?.headers ?? null, now);
  if (rows.some((r) => r.phase === 'open' && r.percent !== null && r.percent >= 100)) return true;
  const h = a?.headers;
  if (h?.status === 'rejected' && (h.resetsAt === null || h.resetsAt > now)) return true;
  return (a?.cooldowns ?? []).some(
    (c) => c.model === null && (c.reason === 'quota' || c.reason === 'credential_quota') && c.retryAt > now,
  );
}

function deriveRead(feeds: AccountFeeds, now: Instant): ReadView {
  const g = feeds.gate;
  const backoff = g.backoffUntil !== null && g.backoffUntil > now ? g.backoffUntil : null;
  const cap = g.capUntil !== null && g.capUntil > now ? g.capUntil : null;
  const manualUntil = g.manualAt === null ? null : ((g.manualAt + MANUAL_REFRESH_EVERY_MS) as Instant);
  const refreshHeld: ReadView['refreshHeld'] =
    g.reading !== null
      ? { why: 'reading', until: null }
      : backoff !== null
        ? { why: 'rate_limited', until: backoff }
        : cap !== null
          ? { why: 'capped', until: cap }
          : manualUntil !== null && manualUntil > now
            ? { why: 'debounced', until: manualUntil }
            : null;
  return { nextAt: feeds.limits.nextAt, reading: g.reading !== null, backoffUntil: backoff, capUntil: cap, refreshHeld };
}

interface Seen {
  readonly lastAt: Instant;
  readonly recent: number | null;
}

function servingEvidence(s: Snapshot, accounts: readonly CpaAccount[]): { kind: 'keeper' | 'cpa_headers'; seen: ReadonlyMap<AccountId, Seen> } {
  if (s.serving.last && !s.serving.error) {
    return { kind: 'keeper', seen: new Map(s.serving.last.value.map((x) => [x.account, { lastAt: x.lastAt, recent: x.recent }])) };
  }
  const seen = new Map<AccountId, Seen>();
  for (const a of accounts) if (a.headers) seen.set(a.id, { lastAt: a.headers.observedAt, recent: null });
  return { kind: 'cpa_headers', seen };
}

type Eligibility = { readonly ok: true } | { readonly ok: false; readonly until: Instant | null; readonly reason: string };

/**
 * `status` (say 'error' with a spend-limit message) is shown but doesn't decide
 * routing: CPA retries the account after nextRetryAfter whatever the status says.
 */
export function eligibility(a: CpaAccount, now: Instant): Eligibility {
  const credential = a.cooldowns.filter((c) => c.model === null && c.retryAt > now);
  const unavailable = a.unavailable && (a.nextRetryAfter === null || a.nextRetryAfter > now);
  if (credential.length === 0 && !unavailable) return { ok: true };
  const times = [...credential.map((c) => c.retryAt), ...(unavailable && a.nextRetryAfter !== null ? [a.nextRetryAfter] : [])];
  const until = unavailable && a.nextRetryAfter === null ? null : (Math.max(...times) as Instant);
  return { ok: false, until, reason: credential[0]?.reason ?? a.statusMessage ?? 'unavailable' };
}

export function deriveRouting(
  accounts: readonly CpaAccount[],
  strategy: RoutingStrategy | null,
  seen: ReadonlyMap<AccountId, Seen>,
  now: Instant,
): ReadonlyMap<AccountId, RoutingView> {
  const eligible = new Map(accounts.map((a) => [a.id, !a.disabled && eligibility(a, now).ok]));
  const topPriority = Math.max(-Infinity, ...accounts.filter((a) => eligible.get(a.id)).map((a) => a.priority));
  const out = new Map<AccountId, RoutingView>();
  for (const a of accounts) {
    const isTarget = eligible.get(a.id)! && (strategy === 'round-robin' || a.priority === topPriority);
    const s = seen.get(a.id);
    const serving = s !== undefined && now - s.lastAt < SERVING_WINDOW_MS;
    const e = eligibility(a, now);
    const role: RoutingView['role'] = a.disabled
      ? { kind: 'disabled' }
      : !e.ok
        ? { kind: 'blocked', until: e.until, reason: e.reason }
        : serving
          ? { kind: 'serving', why: strategy === 'round-robin' ? 'round_robin' : isTarget ? 'fill_first_target' : 'affinity' }
          : { kind: 'standby' };
    out.set(a.id, {
      priority: a.priority,
      role,
      isTarget,
      lastSeenAt: s?.lastAt ?? null,
      recent: s?.recent ?? null,
      outranksAll: accounts.every((o) => o.id === a.id || a.priority > o.priority),
    });
  }
  return out;
}

export function planMakePrimary(accounts: readonly CpaAccount[], target: AccountId): { readonly priority: number | null; readonly enable: boolean } {
  const t = accounts.find((a) => a.id === target);
  if (!t) return { priority: null, enable: false };
  const others = accounts.filter((a) => a.id !== target).map((a) => a.priority);
  const outranks = others.every((p) => t.priority > p);
  return { priority: outranks ? null : Math.max(...others) + 10, enable: t.disabled };
}

interface Observation {
  readonly kind: string;
  readonly scopeModel: string | null;
  readonly percent: Percent;
  readonly severity: Severity;
  readonly resetsAt: Instant | null;
  readonly isActive: boolean;
  readonly source: { readonly kind: 'poll' | 'headers'; readonly at: Instant };
}

export function mergeLimits(poll: Sample<readonly Limit[]> | null, headers: HeaderQuota | null, now: Instant): LimitView[] {
  const rows = new Map<string, { draw: Observation; other: Observation | null }>();
  for (const l of poll?.value ?? []) {
    rows.set(rowKey(l.kind, l.scopeModel), { draw: { ...l, source: { kind: 'poll', at: poll!.at } }, other: null });
  }
  let idleOther: Observation | null = null;
  for (const w of headers?.windows ?? []) {
    const kind = HEADER_TO_KIND[w.key];
    if (!kind || w.percent === null || !headers) continue;
    const obs: Observation = {
      kind,
      scopeModel: null,
      percent: w.percent,
      severity: headerSeverity(w),
      resetsAt: w.resetsAt,
      isActive: false,
      source: { kind: 'headers', at: headers.observedAt },
    };
    const k = rowKey(kind, null);
    const row = rows.get(k);
    if (!row) {
      if (poll && kind === 'session' && obs.source.at <= poll.at) idleOther = obs;
      else rows.set(k, { draw: obs, other: null });
    } else if (obs.source.at > row.draw.source.at) {
      rows.set(k, { draw: { ...obs, isActive: row.draw.isActive }, other: row.draw });
    } else {
      row.other = obs;
    }
  }
  const views: LimitView[] = [...rows.values()].map(({ draw, other }) => {
    const lapsed = draw.resetsAt !== null && draw.resetsAt <= now;
    const otherLive = other && !(other.resetsAt !== null && other.resetsAt <= now);
    return {
      key: rowKey(draw.kind, draw.scopeModel),
      label: limitLabel(draw.kind, draw.scopeModel),
      phase: lapsed ? 'lapsed' : 'open',
      percent: lapsed ? null : draw.percent,
      severity: lapsed ? 'normal' : draw.severity,
      resetsAt: draw.resetsAt,
      isActive: !lapsed && draw.isActive,
      source: draw.source,
      other: otherLive ? { kind: other.source.kind, percent: other.percent, at: other.source.at } : null,
    };
  });
  if (poll && !rows.has(rowKey('session', null))) {
    views.push({
      key: rowKey('session', null),
      label: limitLabel('session', null),
      phase: 'idle',
      percent: null,
      severity: 'normal',
      resetsAt: null,
      isActive: false,
      source: { kind: 'poll', at: poll.at },
      other: idleOther && !(idleOther.resetsAt !== null && idleOther.resetsAt <= now)
        ? { kind: 'headers', percent: idleOther.percent, at: idleOther.source.at }
        : null,
    });
  }
  return views.sort((x, y) => kindRank(x.key) - kindRank(y.key) || x.key.localeCompare(y.key));
}

function rowKey(kind: string, scopeModel: string | null): string {
  return scopeModel === null ? kind : `${kind}:${scopeModel}`;
}

function kindRank(key: string): number {
  const i = KIND_ORDER.indexOf(key.split(':')[0]!);
  return i === -1 ? KIND_ORDER.length : i;
}

function limitLabel(kind: string, scopeModel: string | null): string {
  if (kind === 'session') return 'Session';
  if (kind === 'weekly_all') return 'Weekly';
  if (kind === 'weekly_scoped') return `Weekly · ${scopeModel ?? 'scoped'}`;
  return kind;
}

function headerSeverity(w: HeaderWindow): Severity {
  if (w.status === 'rejected' || (w.percent !== null && w.percent >= 100)) return 'critical';
  if (w.status === 'allowed_warning') return 'warning';
  return 'normal';
}

export function deriveSpend(spend: Source<Spend | null>, headers: HeaderQuota | null): SpendView | null {
  const s = spend.last;
  const overage = headers?.windows.find((w) => w.key === 'Overage');
  const live =
    headers && (overage || headers.overageDisabledReason) && (!s || headers.observedAt > s.at)
      ? { percent: overage?.percent ?? null, status: overage?.status ?? null, reason: headers.overageDisabledReason, at: headers.observedAt }
      : null;
  const poll = s?.value ? { ...s.value, at: s.at } : null;
  return poll || live ? { poll, live } : null;
}

export function derivePlan(profile: Source<Profile>): PlanView | null {
  const p = profile.last?.value;
  if (!p) return null;
  const max = /max_(\d+)x/.exec(p.rateLimitTier);
  const tier = max ? `Max ${max[1]}x` : /pro/.test(p.rateLimitTier) ? 'Pro' : p.rateLimitTier;
  return { label: p.orgType === 'claude_team' ? `Team · ${tier}` : tier };
}

export const PROGRAM_LABEL: Readonly<Record<ProgramId, string>> = {
  juniper_tide: 'Weekly session reset',
  cedar_ember: 'Reset grant',
};

export function juniperState(j: JuniperTide | null): OfferState {
  if (j === null) return { kind: 'not_enrolled' };
  if (!j.eligible) return ineligible(j.ineligibleReason ?? 'unknown');
  if (j.arm !== 'reset') return ineligible('control_arm');
  if (j.available) return { kind: 'claimable', grant: null };
  return { kind: 'waiting', until: j.nextAvailableAt };
}

export function usableGrant(c: CedarEmber, g: Grant): boolean {
  return c.eligible && g.resetsLeft > 0 && !g.paused && g.usableNow;
}

export function cedarState(c: CedarEmber | null, now: Instant): OfferState {
  if (c === null) return { kind: 'not_enrolled' };
  if (!c.eligible) return ineligible(c.ineligibleReason ?? 'unknown');
  if (c.cooldownUntil !== null && c.cooldownUntil > now) return { kind: 'waiting', until: c.cooldownUntil };
  const usable = c.grants.filter((g) => usableGrant(c, g));
  if (usable.length === 0) {
    if (c.grants.length > 0 && c.grants.every((g) => g.resetsLeft <= 0)) return ineligible('exhausted');
    if (c.grants.some((g) => g.paused)) return { kind: 'waiting', until: null };
    return ineligible('not_usable_now');
  }
  const chosen = usable.find((g) => g.id === c.nextGrantId) ?? usable[0]!;
  return { kind: 'claimable', grant: chosen.id };
}

function ineligible(reason: string): OfferState {
  return { kind: 'ineligible', reason, explain: INELIGIBLE_EXPLAIN[reason] ?? reason };
}

export function holdingClaim(claims: readonly ClaimRecord[], account: AccountId, program: ProgramId, readAt: Instant | null): ClaimRecord | undefined {
  return claims.find(
    (c) => c.account === account && c.program === program && (c.state.kind === 'sending' || readAt === null || readAt < c.state.at + SETTLE_LAG_MS),
  );
}

export function programReadAt(feeds: AccountFeeds, program: ProgramId): Instant | null {
  return (program === 'juniper_tide' ? feeds.juniper : feeds.cedar).last?.at ?? null;
}

export function deriveOffers(
  account: AccountId,
  feeds: AccountFeeds,
  atWall: boolean,
  claims: readonly ClaimRecord[],
  now: Instant,
): OfferView[] {
  const j = feeds.juniper;
  const c = feeds.cedar;
  const jHolding = holdingClaim(claims, account, 'juniper_tide', programReadAt(feeds, 'juniper_tide'));
  const cHolding = holdingClaim(claims, account, 'cedar_ember', programReadAt(feeds, 'cedar_ember'));
  const inFlight = (r: ClaimRecord): OfferState => ({
    kind: 'in_flight',
    claim: r.id,
    phase: r.state.kind === 'settled' ? 'confirming' : r.state.kind,
    result: r.state.kind === 'settled' ? r.state.outcome.result : null,
  });
  const unknown = (src: Source<unknown>): OfferState => ({ kind: 'unknown', why: src.error ? 'failing' : 'never_read' });

  const juniper: OfferState = jHolding
    ? inFlight(jHolding)
    : !atWall
      ? { kind: 'held', lastAt: j.last?.at ?? null, lastClaimable: j.last ? juniperState(j.last.value).kind === 'claimable' : false }
      : j.last
        ? juniperState(j.last.value)
        : unknown(j);

  const cv = c.last?.value ?? null;
  const cedar: OfferState = cHolding ? inFlight(cHolding) : c.last ? cedarState(cv, now) : unknown(c);
  const defaultGrant = cedar.kind === 'claimable' ? cv?.grants.find((g) => g.id === cedar.grant) : undefined;

  return [
    {
      program: 'juniper_tide',
      label: PROGRAM_LABEL.juniper_tide,
      effect: 'Clears the session (5h) limit now. One per week.',
      state: juniper,
      dataAt: j.last?.at ?? null,
      grants: [],
    },
    {
      program: 'cedar_ember',
      label: PROGRAM_LABEL.cedar_ember,
      effect: defaultGrant ? `Clears ${clearsText(defaultGrant.clears)}. Uses 1 of ${defaultGrant.resetsLeft} left on "${defaultGrant.label}".` : 'Clears the limits the grant names.',
      state: cedar,
      dataAt: c.last?.at ?? null,
      grants: (cv?.grants ?? []).map((g) => ({
        id: g.id,
        label: g.label,
        resetsLeft: g.resetsLeft,
        resetsTotal: g.resetsTotal,
        endsAt: g.endsAt,
        clears: g.clears,
        usable: cv !== null && usableGrant(cv, g),
      })),
    },
  ];
}

export function clearsText(clears: readonly string[]): string {
  return clears.length === 0 ? 'nothing named' : clears.map((w) => WINDOW_WORDS[w] ?? w).join(' and ');
}

export function explainOffer(state: OfferState): string {
  switch (state.kind) {
    case 'claimable':
      return 'claimable';
    case 'held':
      return 'held: offered only at the wall, and the account is not at it';
    case 'waiting':
      return state.until === null ? 'waiting: paused' : `waiting until ${new Date(state.until).toISOString()}`;
    case 'ineligible':
      return `ineligible (${state.reason}): ${state.explain}`;
    case 'not_enrolled':
      return 'not enrolled in this program';
    case 'in_flight':
      return 'a claim for this program is already in flight';
    case 'unknown':
      return 'no reset data yet';
  }
}

export function freshness<T>(feed: Exclude<FeedName, 'headers'>, src: Source<T>, now: Instant, held = false): FreshnessView {
  const ageMs = src.last ? now - src.last.at : null;
  const t = FRESHNESS[feed];
  const state: FreshnessView['state'] = held
    ? 'held'
    : src.error
      ? 'failing'
      : ageMs === null
        ? 'never'
        : ageMs < t.aging
          ? 'fresh'
          : ageMs < t.stale
            ? 'aging'
            : 'stale';
  return {
    feed,
    state,
    ageMs,
    error: src.error?.value ?? null,
    errorAgeMs: src.error ? now - src.error.at : null,
    nextAt: held ? null : src.nextAt,
  };
}

export function headerFreshness(headers: HeaderQuota | null, now: Instant): FreshnessView {
  return {
    feed: 'headers',
    state: headers ? 'traffic' : 'never',
    ageMs: headers ? now - headers.observedAt : null,
    error: null,
    errorAgeMs: null,
    nextAt: null,
  };
}

export function deriveOverview(accounts: readonly AccountView[], evidence: 'keeper' | 'cpa_headers'): OverviewView {
  const serving = accounts
    .flatMap((a) => (a.routing.role.kind === 'serving' && a.routing.lastSeenAt !== null ? [{ account: a.id, email: a.email, why: a.routing.role.why, lastAt: a.routing.lastSeenAt }] : []))
    .sort((x, y) => y.lastAt - x.lastAt);
  const targets = accounts
    .filter((a) => a.routing.isTarget)
    .sort((x, y) => (y.routing.lastSeenAt ?? 0) - (x.routing.lastSeenAt ?? 0) || x.email.localeCompare(y.email));
  const enabled = accounts.filter((a) => a.routing.role.kind !== 'disabled');

  let nextReset: OverviewView['nextReset'] = null;
  for (const a of accounts) {
    for (const l of a.limits) {
      if (l.phase === 'open' && l.resetsAt !== null && (nextReset === null || l.resetsAt < nextReset.at)) {
        nextReset = { account: a.id, email: a.email, label: l.label, at: l.resetsAt };
      }
    }
  }
  let nextUnblock: OverviewView['nextUnblock'] = null;
  for (const a of accounts) {
    const r = a.routing.role;
    if (r.kind === 'blocked' && r.until !== null && (nextUnblock === null || r.until < nextUnblock.at)) {
      nextUnblock = { account: a.id, email: a.email, at: r.until };
    }
  }
  const claimable: ClaimableView[] = accounts.flatMap((a) =>
    a.offers.flatMap((o) => {
      if (o.state.kind !== 'claimable') return [];
      const grant = o.state.grant;
      const grantLabel = o.grants.find((g) => g.id === grant)?.label;
      return [{ account: a.id, email: a.email, program: o.program, grant, label: grantLabel ? `${o.label} · ${grantLabel}` : o.label }];
    }),
  );
  return {
    serving,
    target: targets[0] ? { account: targets[0].id, email: targets[0].email } : null,
    servingEvidence: evidence,
    headroom: { session: headroom(enabled, 'session'), weekly: headroom(enabled, 'weekly') },
    nextReset,
    nextUnblock,
    claimable,
  };
}

function left(limits: readonly LimitView[], key: string): number | null {
  const l = limits.find((x) => x.key === key);
  if (!l) return null;
  if (l.phase !== 'open' || l.percent === null) return 100;
  return Math.max(0, 100 - l.percent);
}

function headroom(accounts: readonly AccountView[], which: 'session' | 'weekly'): Headroom {
  let value = 0;
  let unknown = 0;
  for (const a of accounts) {
    const weekly = left(a.limits, 'weekly_all');
    const session = left(a.limits, 'session');
    const v = which === 'weekly' ? weekly : session === null && weekly === null ? null : Math.min(session ?? 100, weekly ?? 100);
    if (v === null) unknown += 1;
    else value += v / 100;
  }
  return { value: Math.round(value * 100) / 100, of: accounts.length, unknown };
}

function deriveBanners(s: Snapshot, views: readonly AccountView[]): Banner[] {
  const banners: Banner[] = [];
  if (s.link.kind !== 'ok') {
    banners.push({ kind: 'link', link: s.link, retryAt: s.link.kind === 'rejected' ? ((s.link.at + KEY_REJECT_LATCH_MS) as Instant) : null });
  } else if (s.cpa.error && s.cpa.error.value.kind !== 'link_down') {
    banners.push({ kind: 'cpa_unreachable', lastAt: s.cpa.last?.at ?? null });
  }
  for (const v of views) {
    for (const o of v.offers) {
      if (o.state.kind === 'in_flight' && o.state.phase === 'maybe_sent') banners.push({ kind: 'claim_unknown', claim: o.state.claim, email: v.email, program: o.program });
    }
  }
  if (s.serving.error) {
    banners.push({ kind: 'keeper_unavailable', message: s.serving.error.value.kind === 'unavailable' ? s.serving.error.value.message : s.serving.error.value.kind });
  }
  return banners;
}
