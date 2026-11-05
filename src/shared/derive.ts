import {
  emptyFeeds,
  PRIORITY_RANGE,
  type AccountFeeds,
  type AccountId,
  type CedarEmber,
  type ClaimRecord,
  type Cooldown,
  type CpaAccount,
  type Grant,
  type HeaderQuota,
  type HeaderWindow,
  type Instant,
  type JuniperTide,
  type Limit,
  type Money,
  type Percent,
  type PercentLeft,
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
  CpaView,
  DeckView,
  FeedName,
  FreshnessView,
  LimitColumn,
  LimitView,
  MeterTone,
  OfferState,
  OfferView,
  OverviewView,
  PlanView,
  ReadView,
  RoutingView,
  ServeLine,
  ServeOrderView,
  SpendState,
  SpendView,
  StatusView,
  TroubleView,
} from './view';

export const SERVING_WINDOW_MS = 120_000;
export const NORMAL_READ_EVERY_MS = 5 * 60_000;
export const WALL_READ_EVERY_MS = 3 * 60_000;
export const PROFILE_READ_EVERY_MS = 6 * 3_600_000;
export const MANUAL_REFRESH_EVERY_MS = 60_000;
/** One rejected key per 35 min can never reach CPA's 5-strikes-in-30-min ban. */
export const KEY_REJECT_LATCH_MS = 35 * 60_000;
export const CLAUDE_CODE_CLAIM_TIMEOUT_MS = 25_000;
const PRIORITY_STEP = 10;
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
  surface: 'Request did not look like Claude Code. Headroom sent the wrong User-Agent or x-app header.',
  mobile: 'Only offered on mobile.',
  cli_version: 'The Claude Code version Headroom reports is too old.',
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

const WINDOW_LIMIT: Readonly<Record<string, string>> = {
  five_hour: 'session',
  seven_day: 'weekly_all',
};

const JUNIPER_CLEARS: readonly string[] = ['five_hour'];

export const REASON_TEXT: Readonly<Record<string, string>> = {
  quota: 'no quota left',
  credential_quota: 'no quota left',
  unauthorized: 'token rejected',
  payment_required: 'payment required',
  not_found: 'not found',
  invalid_grant: 'sign-in expired, log in again',
  cloudflare_challenge: 'blocked by a Cloudflare challenge',
  model_not_supported: 'model not supported',
  transient_error: 'temporary error',
  org_spend_cap_reached: 'monthly spend cap reached',
  org_level_disabled: 'extra usage is off for the organization',
  group_zero_credit_limit: 'no extra-usage credit',
};

/** quota: the cause only bites once a plan limit has nothing left, so an emptied window is what holds the account. */
const MESSAGE_CAUSES: readonly { readonly pattern: RegExp; readonly cause: string; readonly quota: boolean }[] = [
  { pattern: /monthly spend limit/i, cause: 'Monthly spend limit hit', quota: true },
];
const QUOTA_REASONS: ReadonlySet<string> = new Set(['quota', 'credential_quota']);

/** The page shows minutes, so two times this close read as one moment. */
const SAME_MOMENT_MS = MINUTE_MS;

export function deriveDeck(s: Snapshot, now: Instant): DeckView {
  const accounts = s.cpa.last?.value ?? [];
  const evidence = servingEvidence(s, accounts);
  const strategy = s.strategy.last?.value ?? null;
  const routing = deriveRouting(accounts, strategy, evidence.seen, now);
  const cpa = deriveCpa(s);
  const views = accounts
    .map((a) => deriveAccount(a, s.feeds[a.id] ?? emptyFeeds(), routing.get(a.id)!, s.claims, now, cpa))
    .sort((x, y) => x.email.localeCompare(y.email));
  return {
    now,
    overview: deriveOverview(views, evidence.kind, strategy),
    accounts: views,
    banners: deriveBanners(s, views, cpa),
    flows: s.flows,
    strategy: s.strategy.last?.value ?? null,
    status: deriveStatus([freshness('cpa', s.cpa, now), freshness('strategy', s.strategy, now), freshness('serving', s.serving, now)]),
    cpa,
    limitColumns: limitColumns(views),
  };
}

function limitColumns(views: readonly AccountView[]): LimitColumn[] {
  const columns = new Map(views.flatMap((a) => a.limits.map((l) => [l.key, l.label] as const)));
  return [...columns]
    .map(([key, label]) => ({ key, label }))
    .sort((x, y) => kindRank(x.key) - kindRank(y.key) || x.key.localeCompare(y.key));
}

const PROBLEM_ORDER: readonly FreshnessView['state'][] = ['failing', 'stale', 'never', 'aging'];

function deriveStatus(sources: readonly FreshnessView[]): StatusView {
  const rank = (f: FreshnessView) => PROBLEM_ORDER.indexOf(f.state);
  const ages = sources.flatMap((f) => (f.ageMs === null ? [] : [f.ageMs]));
  return {
    sources,
    problems: sources.filter((f) => rank(f) >= 0).sort((x, y) => rank(x) - rank(y)),
    newestAgeMs: ages.length === 0 ? null : Math.min(...ages),
  };
}

function deriveCpa(s: Snapshot): CpaView {
  return s.link.kind === 'ok' && s.cpa.error !== null && s.cpa.error.value.kind !== 'link_down'
    ? { kind: 'down', lastAt: s.cpa.last?.at ?? null }
    : { kind: 'up' };
}

export function deriveAccount(
  a: CpaAccount,
  feeds: AccountFeeds,
  routing: RoutingView,
  claims: readonly ClaimRecord[],
  now: Instant,
  cpa: CpaView,
): AccountView {
  const limits = mergeLimits(feeds.limits.last, a.headers, now);
  const atWall = isAtWall(a, feeds.limits.last, now);
  const mine = claims.filter((c) => c.account === a.id);
  const read = deriveRead(feeds, now, cpa);
  const { offers, offersClear } = deriveOffers(a.id, feeds, atWall, mine, now, limits);
  return {
    id: a.id,
    email: a.email,
    plan: derivePlan(feeds.profile),
    routing,
    cooldowns: a.cooldowns.filter((c) => c.retryAt > now).map(({ httpStatus: _, ...view }) => view),
    statusMessage: a.statusMessage,
    trouble: deriveTrouble(a, now, limits),
    atWall,
    limits,
    spend: deriveSpend(feeds.spend, a.headers),
    offers,
    offersClear,
    quietOffers: quietOffers(offers),
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
      makePrimary: !routing.primary && (a.disabled || !routing.outranksAll),
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
    (c) => c.scope === 'credential' && (c.reason === 'quota' || c.reason === 'credential_quota') && c.retryAt > now,
  );
}

function deriveRead(feeds: AccountFeeds, now: Instant, cpa: CpaView): ReadView {
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
  return { lastAt: freshestRead(feeds), nextAt: feeds.limits.nextAt, reading: g.reading !== null, paused: cpa.kind === 'down', backoffUntil: backoff, capUntil: cap, refreshHeld };
}

function freshestRead(feeds: AccountFeeds): Instant | null {
  const ats = [feeds.limits, feeds.spend, feeds.cedar, feeds.juniper].flatMap((s) => (s.last ? [s.last.at] : []));
  return ats.length === 0 ? null : (Math.max(...ats) as Instant);
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
  const credential = a.cooldowns.filter((c) => c.scope === 'credential' && c.retryAt > now);
  const unavailable = a.unavailable && (a.nextRetryAfter === null || a.nextRetryAfter > now);
  if (credential.length === 0 && !unavailable) return { ok: true };
  const times = [...credential.map((c) => c.retryAt), ...(unavailable && a.nextRetryAfter !== null ? [a.nextRetryAfter] : [])];
  const until = unavailable && a.nextRetryAfter === null ? null : (Math.max(...times) as Instant);
  return { ok: false, until, reason: credential[0]?.reason ?? a.statusMessage ?? 'unavailable' };
}

function deriveTrouble(a: CpaAccount, now: Instant, limits: readonly LimitView[]): TroubleView | null {
  const live = a.cooldowns.filter((c) => c.retryAt > now);
  const holds = deriveHolds(
    eligibility(a, now),
    live.flatMap((c) => (c.scope === 'model' ? [c] : [])),
  );
  if (holds.length === 0 && a.statusMessage === null) return null;
  const message = messageCause(a.statusMessage);
  const quota = message ? message.quota : live.some((c) => QUOTA_REASONS.has(c.reason));
  const full = quota ? limits.find((l) => l.phase === 'open' && l.percent !== null && l.percent >= 100) : undefined;
  const resetsAt = full?.resetsAt ?? null;
  const lifts = resetsAt !== null && holds.length > 0 && holds.every((h) => h.until !== null && Math.abs(h.until - resetsAt) <= SAME_MOMENT_MS);
  return { cause: deriveCause(a.statusMessage, live), holds, limit: full ? { label: full.label, liftsAt: lifts ? resetsAt : null } : null };
}

const messageCause = (message: string | null) => MESSAGE_CAUSES.find((m) => message !== null && m.pattern.test(message));

function deriveCause(message: string | null, live: readonly Cooldown[]): string {
  const phrase = messageCause(message);
  if (phrase) return phrase.cause;
  const named = live.filter((c) => c.reason !== 'unknown');
  const reason = (named.find((c) => c.scope === 'credential') ?? named[0])?.reason;
  const text = reason === undefined ? message : (REASON_TEXT[reason] ?? reason);
  return text === null ? 'Reason unknown' : text.charAt(0).toUpperCase() + text.slice(1);
}

function deriveHolds(gate: Eligibility, models: readonly { readonly model: string; readonly retryAt: Instant }[]): TroubleView['holds'] {
  const modelsUntil = models.length === 0 ? null : (Math.max(...models.map((c) => c.retryAt)) as Instant);
  const named = models.length === 1 ? models[0]!.model.replace(/^claude-/, '') : `${models.length} models`;
  if (gate.ok) return modelsUntil === null ? [] : [{ what: `${named} cooling down`, until: modelsUntil }];
  if (modelsUntil === null) return [{ what: 'account cooling down', until: gate.until }];
  if (gate.until === null || modelsUntil <= gate.until + SAME_MOMENT_MS) return [{ what: `account and ${named} cooling down`, until: gate.until }];
  return [
    { what: 'account cooling down', until: gate.until },
    { what: `${named} cooling down`, until: modelsUntil },
  ];
}

export function deriveRouting(
  accounts: readonly CpaAccount[],
  strategy: RoutingStrategy | null,
  seen: ReadonlyMap<AccountId, Seen>,
  now: Instant,
): ReadonlyMap<AccountId, RoutingView> {
  const eligible = new Map(accounts.map((a) => [a.id, !a.disabled && eligibility(a, now).ok]));
  const topPriority = Math.max(-Infinity, ...accounts.filter((a) => eligible.get(a.id)).map((a) => a.priority));
  const atTop = accounts.filter((a) => eligible.get(a.id) && a.priority === topPriority);
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
      step: PRIORITY_STEP,
      stepTo: stepTo(a.priority),
      role,
      isTarget,
      primary: strategy !== 'round-robin' && atTop.length === 1 && atTop[0] === a,
      ranksByPriority: strategy !== 'round-robin',
      lastSeenAt: s?.lastAt ?? null,
      recent: s?.recent ?? null,
      outranksAll: accounts.every((o) => o.id === a.id || a.priority > o.priority),
    });
  }
  return out;
}

function stepTo(priority: number): RoutingView['stepTo'] {
  const { min, max } = PRIORITY_RANGE;
  return {
    down: priority <= min ? null : Math.max(min, priority - PRIORITY_STEP),
    up: priority >= max ? null : Math.min(max, priority + PRIORITY_STEP),
  };
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

const percentLeft = (used: Percent): PercentLeft => Math.min(100, Math.max(0, 100 - used)) as PercentLeft;
const percentLeftOrNull = (used: Percent | null): PercentLeft | null => (used === null ? null : percentLeft(used));

/** Over half left is room to spare: the meter recedes so the windows running low are the ones that stand out. */
const AMPLE_LEFT = 50;

export function meterTone(severity: Severity, left: PercentLeft | null): MeterTone {
  return severity === 'normal' && left !== null && left > AMPLE_LEFT ? 'ample' : severity;
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
    const left = lapsed ? null : percentLeft(draw.percent);
    const severity = lapsed ? 'normal' : draw.severity;
    return {
      key: rowKey(draw.kind, draw.scopeModel),
      label: limitLabel(draw.kind, draw.scopeModel),
      phase: lapsed ? 'lapsed' : 'open',
      percent: lapsed ? null : draw.percent,
      left,
      severity,
      tone: meterTone(severity, left),
      resetsAt: draw.resetsAt,
      limiting: !lapsed && draw.isActive && draw.severity !== 'normal',
      source: draw.source,
      other: otherLive ? otherView(other) : null,
    };
  });
  if (poll && !rows.has(rowKey('session', null))) {
    views.push({
      key: rowKey('session', null),
      label: limitLabel('session', null),
      phase: 'idle',
      percent: null,
      left: 100 as PercentLeft,
      severity: 'normal',
      tone: 'ample',
      resetsAt: null,
      limiting: false,
      source: { kind: 'poll', at: poll.at },
      other: idleOther && !(idleOther.resetsAt !== null && idleOther.resetsAt <= now) ? otherView(idleOther) : null,
    });
  }
  return views.sort((x, y) => kindRank(x.key) - kindRank(y.key) || x.key.localeCompare(y.key));
}

function otherView(other: Observation): NonNullable<LimitView['other']> {
  return { kind: other.source.kind, left: percentLeft(other.percent), at: other.source.at };
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
      ? {
          left: percentLeftOrNull(overage?.percent ?? null),
          status: overage?.status ?? null,
          reason: headers.overageDisabledReason,
          severity: overage ? headerSeverity(overage) : 'normal',
          resetsAt: overage?.resetsAt ?? null,
          at: headers.observedAt,
        }
      : null;
  const poll = s?.value ? pollView(s.value, s.at, live?.severity === 'critical') : null;
  return poll || live ? { poll, live } : null;
}

function pollView({ enabled, percent, ...rest }: Spend, at: Instant, liveCritical: boolean): NonNullable<SpendView['poll']> {
  const { used, limit } = rest;
  const left = percentLeftOrNull(percent);
  const remaining = limit && { ...limit, minor: Math.max(0, limit.minor - used.minor) };
  const state = spendState(enabled, used, limit);
  const tone = meterTone(liveCritical || state === 'cap_used' ? 'critical' : rest.severity, left);
  return { ...rest, state, left, tone, remaining, at };
}

function spendState(enabled: boolean, used: Money, limit: Money | null): SpendState {
  if (!enabled) return 'off';
  if (limit === null) return 'budget';
  if (limit.minor === 0) return 'no_budget';
  return used.minor >= limit.minor ? 'cap_used' : 'budget';
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
  cedar_ember: 'Bonus reset',
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

function limitsNamed(clears: readonly string[]): string {
  const windows = clears.map((w) => limitLabel(WINDOW_LIMIT[w] ?? w, null).toLowerCase());
  return windows.length === 0 ? 'limit' : `${windows.join(' and ')} ${windows.length === 1 ? 'limit' : 'limits'}`;
}

function selfResets(clears: readonly string[], limits: readonly LimitView[]): OfferView['selfResets'] {
  return clears.flatMap((w) => {
    const l = limits.find((x) => x.key === WINDOW_LIMIT[w]);
    return l?.phase === 'open' && l.resetsAt !== null ? [{ what: `the ${l.label.toLowerCase()} limit`, at: l.resetsAt }] : [];
  });
}

export function deriveOffers(
  account: AccountId,
  feeds: AccountFeeds,
  atWall: boolean,
  claims: readonly ClaimRecord[],
  now: Instant,
  limits: readonly LimitView[],
): Pick<AccountView, 'offers' | 'offersClear'> {
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
  const grants = cv?.grants ?? [];
  const cedarClears = defaultGrant?.clears ?? [...new Set(grants.flatMap((g) => g.clears))];
  const offersClear =
    cedarClears.length === JUNIPER_CLEARS.length && JUNIPER_CLEARS.every((w) => cedarClears.includes(w)) ? `the ${limitsNamed(JUNIPER_CLEARS)}` : null;
  const clearsTerm = (clears: readonly string[]) => (offersClear === null && clears.length > 0 ? [`clears the ${limitsNamed(clears)}`] : []);

  return {
    offersClear,
    offers: [
      {
        program: 'juniper_tide',
        name: 'Weekly reset',
        terms: clearsTerm(JUNIPER_CLEARS),
        effect: `Clears ${clearsText(JUNIPER_CLEARS)} now. One per week.`,
        selfResets: selfResets(JUNIPER_CLEARS, limits),
        state: juniper,
        dataAt: j.last?.at ?? null,
        grants: [],
      },
      {
        program: 'cedar_ember',
        name: 'Bonus reset',
        terms: clearsTerm(cedarClears),
        effect: defaultGrant ? `Clears ${clearsText(defaultGrant.clears)}. Uses 1 of ${defaultGrant.resetsLeft} left on "${defaultGrant.label}".` : 'Clears the limits the grant names.',
        selfResets: selfResets(cedarClears, limits),
        state: cedar,
        dataAt: c.last?.at ?? null,
        grants: grants.map((g) => ({
          id: g.id,
          label: g.label,
          resetsLeft: g.resetsLeft,
          resetsTotal: g.resetsTotal,
          endsAt: g.endsAt,
          clears: g.clears,
          clearsText: clearsText(g.clears),
          usable: cv !== null && usableGrant(cv, g),
        })),
      },
    ],
  };
}

const PROGRAM_SHORT: Readonly<Record<ProgramId, string>> = {
  juniper_tide: 'weekly reset',
  cedar_ember: 'bonus resets',
};

const QUIET_REASON: Readonly<Record<string, string>> = {
  no_grant: 'no bonus resets',
  exhausted: 'bonus resets used up',
  not_usable_now: 'no bonus reset usable now',
};
/** Reasons that mean Headroom's own requests are wrong, so the operator has something to fix. */
const LOUD_REASONS = new Set(['surface', 'cli_version']);

function quietOffer(o: OfferView): string | null {
  const s = o.state;
  switch (s.kind) {
    case 'held':
      return `${PROGRAM_SHORT[o.program]} offered at limit`;
    case 'ineligible':
      if (LOUD_REASONS.has(s.reason)) return null;
      return QUIET_REASON[s.reason] ?? (s.explain.charAt(0).toLowerCase() + s.explain.slice(1)).replace(/\.$/, '');
    case 'not_enrolled':
      return `${PROGRAM_SHORT[o.program]} not enrolled`;
    case 'claimable':
    case 'waiting':
    case 'in_flight':
    case 'unknown':
      return null;
  }
}

export function quietOffers(offers: readonly OfferView[]): readonly string[] | null {
  const parts = offers.map(quietOffer);
  return parts.every((p) => p !== null) ? ['none', ...parts] : null;
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

/** Among accounts CPA ranks alike, the one it answered from most recently goes first, then by email. */
const byRecent = (x: AccountView, y: AccountView) => (y.routing.lastSeenAt ?? 0) - (x.routing.lastSeenAt ?? 0) || x.email.localeCompare(y.email);

export function deriveOverview(accounts: readonly AccountView[], evidence: 'keeper' | 'cpa_headers', strategy: RoutingStrategy | null): OverviewView {
  const target = accounts.filter((a) => a.routing.isTarget).sort(byRecent)[0];
  const serving = accounts
    .flatMap((a) =>
      a.routing.role.kind === 'serving' && a.routing.lastSeenAt !== null
        ? [{ account: a.id, email: a.email, why: a.routing.role.why, lastAt: a.routing.lastSeenAt, takesNext: a.id === target?.id }]
        : [],
    )
    .sort((x, y) => y.lastAt - x.lastAt);

  let nextReset: OverviewView['nextReset'] = null;
  for (const a of accounts) {
    for (const l of a.limits) {
      if (l.phase === 'open' && l.resetsAt !== null && (nextReset === null || l.resetsAt < nextReset.at)) {
        nextReset = { account: a.id, email: a.email, label: l.label, at: l.resetsAt };
      }
    }
  }
  const claimable: ClaimableView[] = accounts.flatMap((a) => {
    const resets = a.offers.flatMap((o) => {
      if (o.state.kind !== 'claimable') return [];
      const grant = o.state.grant;
      const g = o.grants.find((x) => x.id === grant);
      return [{ program: o.program, grant, name: o.name, detail: g ? `${g.resetsLeft} of ${g.resetsTotal} left` : null }];
    });
    return resets.length === 0 ? [] : [{ account: a.id, email: a.email, resets }];
  });
  return {
    serving,
    target: target ? { account: target.id, email: target.email } : null,
    servingEvidence: evidence,
    order: deriveServeOrder(accounts, strategy === 'round-robin'),
    nextReset,
    claimable,
    claimableCount: claimable.reduce((n, g) => n + g.resets.length, 0),
  };
}

const windowLeft = (limits: readonly LimitView[], key: string) => limits.find((l) => l.key === key)?.left ?? null;

/** Fill-first's rule, as routing and Make primary read it: the highest priority CPA can send to goes first. */
function deriveServeOrder(accounts: readonly AccountView[], rotates: boolean): ServeOrderView {
  const who = (a: AccountView) => ({ account: a.id, email: a.email });
  const inLine = accounts
    .filter((a) => a.routing.role.kind === 'serving' || a.routing.role.kind === 'standby')
    .sort((x, y) => y.routing.priority - x.routing.priority || byRecent(x, y))
    .map((a, i): ServeLine => ({ ...who(a), kind: 'in_line', rank: i + 1, session: windowLeft(a.limits, 'session'), weekly: windowLeft(a.limits, 'weekly_all') }));
  const blocked = accounts
    .flatMap((a) =>
      a.routing.role.kind === 'blocked' ? [{ ...who(a), kind: 'blocked' as const, until: a.trouble?.limit?.liftsAt ?? a.routing.role.until, reason: a.routing.role.reason }] : [],
    )
    .sort((x, y) => (x.until ?? Infinity) - (y.until ?? Infinity) || x.email.localeCompare(y.email));
  const disabled = accounts.filter((a) => a.routing.role.kind === 'disabled').map((a): ServeLine => ({ ...who(a), kind: 'disabled' }));
  return { rotates, lines: [...inLine, ...blocked, ...disabled] };
}

function deriveBanners(s: Snapshot, views: readonly AccountView[], cpa: CpaView): Banner[] {
  const banners: Banner[] = [];
  if (s.link.kind !== 'ok') {
    banners.push({ kind: 'link', link: s.link, retryAt: s.link.kind === 'rejected' ? ((s.link.at + KEY_REJECT_LATCH_MS) as Instant) : null });
  } else if (cpa.kind === 'down') {
    banners.push({ kind: 'cpa_unreachable', lastAt: cpa.lastAt });
  }
  for (const v of views) {
    for (const o of v.offers) {
      if (o.state.kind === 'in_flight' && o.state.phase === 'maybe_sent') banners.push({ kind: 'claim_unknown', claim: o.state.claim, email: v.email, program: o.program, label: PROGRAM_LABEL[o.program] });
    }
  }
  if (s.serving.error) {
    banners.push({ kind: 'keeper_unavailable', message: s.serving.error.value.kind === 'unavailable' ? s.serving.error.value.message : s.serving.error.value.kind });
  }
  return banners;
}
