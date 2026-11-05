import { OUTCOMES, type AccountId, type Effort, type Instant, type Outcome, type TokenSums } from './domain';
import type {
  AccountView,
  AnalyticsLens,
  AnalyticsView,
  ErrorEventView,
  Grain,
  PaceAccountView,
  PaceOutlook,
  PaceView,
  Part,
  Percentiles,
  TimeBucket,
  UsageRange,
  UsageStats,
  WeekCell,
  WeekGrid,
  Weekday,
} from './view';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** What each range spans and its default grain. */
const RANGE_SPAN: Readonly<Record<UsageRange, { readonly ms: number; readonly grain: Grain }>> = {
  '24h': { ms: 24 * HOUR_MS, grain: 'hour' },
  '7d': { ms: 7 * DAY_MS, grain: 'day' },
  '30d': { ms: 30 * DAY_MS, grain: 'day' },
};

/** How far back the cube reaches: the longest range plus one day, so the oldest local day of a 30d lens is whole in every zone. */
export const HORIZON_MS: number = Math.max(...Object.values(RANGE_SPAN).map((r) => r.ms)) + DAY_MS;

/**
 * The one latency histogram scheme: the ledger writes with it and deriveAnalytics reads with it. Bin i holds
 * [floorMs·2^(i/binsPerDoubling), floorMs·2^((i+1)/binsPerDoubling)). Bin 0 also holds anything faster and the last
 * bin anything slower. 4 bins per doubling makes a bin 19% wide, and 72 bins reach about 7 h.
 */
export const LATENCY_SCALE = { floorMs: 100, binsPerDoubling: 4, bins: 72 } as const;

export function latencyBin(ms: number): number {
  const { floorMs, binsPerDoubling, bins } = LATENCY_SCALE;
  return Math.min(bins - 1, Math.max(0, Math.floor(Math.log2(Math.max(ms, floorMs) / floorMs) * binsPerDoubling)));
}

/**
 * Hourly usage over the horizon as the server read it from keeper: the one analytics shape. The server builds it,
 * /api/usage carries it unchanged, and deriveAnalytics folds it. It holds no range or time-zone decision.
 *  - cells are sorted by hour, account, model and effort, and that tuple is unique.
 *  - hour is a whole UTC hour, which folds exactly into any whole-hour local zone.
 *  - every measure in a Tally adds up across cells. Percentiles are the one approximation, to a bin.
 *  - only the accounts CPA currently knows appear.
 */
export interface UsageCube {
  readonly generatedAt: Instant;
  readonly horizonStart: Instant;
  /** The server is still reading the horizon, so the cells hold only part of it. */
  readonly catchingUp: boolean;
  /** Timestamp of the newest usage_events row read. */
  readonly keeperLatestAt: Instant | null;
  readonly cells: readonly UsageCell[];
  /** The newest error_events inside the horizon, newest first. */
  readonly errors: readonly ErrorEvent[];
}

export interface UsageCell {
  readonly hour: Instant;
  readonly account: AccountId;
  readonly model: string;
  readonly effort: Effort;
  readonly tally: Tally;
}

/** No `requests` field: it is the sum of outcomes, so the two cannot disagree. */
export interface Tally {
  readonly outcomes: Readonly<Record<Outcome, number>>;
  readonly tokens: TokenSums;
  /** Sessions whose first request inside the horizon landed in this cell. */
  readonly sessionsStarted: number;
  /** Ok requests only. A failed request's latency measures the failure, not the model. */
  readonly latencyMs: Histogram;
  /** Ok requests that reported a time to first token. */
  readonly ttftMs: Histogram;
}

/** Sparse, sorted by bin, with no zero counts. */
export type Histogram = readonly HistogramBin[];
export type HistogramBin = readonly [bin: number, count: number];

export interface ErrorEvent {
  readonly id: number;
  readonly at: Instant | null;
  readonly account: AccountId | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly outcome: Outcome | null;
  readonly quotaReason: string | null;
  readonly recoverAt: Instant | null;
  /** The upstream error message, parsed out of the body. The body itself never leaves keeper.ts. */
  readonly message: string;
}

/** Below this many samples a percentile says more about the sample than the latency. */
const MIN_SAMPLES = 20;
const EFFORT_LADDER: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

type Fold = Omit<AnalyticsView, 'pace'>;
const folds = new WeakMap<UsageCube, Map<string, Fold>>();

/**
 * The one way to turn usage history into what a chart reads. Pure, so tests call it with a hand-built cube.
 * Lens filters apply before any sum, and dimensions are taken after them. Pace comes from each account's open
 * LimitViews, which deriveDeck already timed, joined with the cube for what the window has cost. The fold is memoized
 * per cube and lens, so passing a new deck's accounts every second recomputes only pace.
 */
export function deriveAnalytics(cube: UsageCube, lens: AnalyticsLens, accounts: readonly AccountView[]): AnalyticsView {
  const resolved = { range: lens.range, grain: lens.grain ?? RANGE_SPAN[lens.range].grain, account: lens.account ?? null, model: lens.model ?? null };
  const key = [resolved.range, resolved.grain, resolved.account, resolved.model, ...accounts.map((a) => `${a.id}:${a.email}`)].join('|');
  let memo = folds.get(cube);
  if (!memo) folds.set(cube, (memo = new Map()));
  let fold = memo.get(key);
  if (!fold) memo.set(key, (fold = foldCube(cube, resolved, accounts)));
  return { ...fold, pace: derivePace(cube, accounts.filter((a) => resolved.account === null || a.id === resolved.account)) };
}

function foldCube(cube: UsageCube, lens: AnalyticsView['lens'], accounts: readonly AccountView[]): Fold {
  const starts = bucketStarts(lens.range, lens.grain, cube.generatedAt);
  const n = starts.length - 1;
  const spanStart = starts[0]!;
  const spanEnd = starts[n]!;
  const dimAccounts = accounts.filter((a) => lens.account === null || a.id === lens.account).map((a) => ({ id: a.id, email: a.email }));
  const accountIndex = new Map(dimAccounts.map((a, i) => [a.id, i]));
  const inLens = (c: UsageCell) => accountIndex.has(c.account) && (lens.model === null || c.model === lens.model);
  const cells = cube.cells.filter((c) => c.hour >= spanStart && c.hour < spanEnd && inLens(c));
  const previous = foldPrevious(cube, lens.range, starts, inLens);

  const total = new Acc();
  const byModel = new Map<string, Acc>();
  const byEffort = new Map<Effort, Acc>();
  const byAccountModel = new Map<string, { account: AccountId; model: string; acc: Acc }>();
  for (const c of cells) {
    total.add(c.tally);
    getOr(byModel, c.model, () => new Acc()).add(c.tally);
    getOr(byEffort, c.effort, () => new Acc()).add(c.tally);
    getOr(byAccountModel, `${c.account}|${c.model}`, () => ({ account: c.account, model: c.model, acc: new Acc() })).acc.add(c.tally);
  }
  const models = [...byModel].sort(([a, x], [b, y]) => y.requests() - x.requests() || a.localeCompare(b)).map(([m]) => m);
  const efforts = [...byEffort.keys()].sort(effortOrder);
  const modelIndex = new Map(models.map((m, i) => [m, i]));
  const effortIndex = new Map(efforts.map((e, i) => [e, i]));

  const buckets = Array.from({ length: n }, () => ({ total: new Acc(), accounts: dimAccounts.map(() => new Acc()), models: models.map(() => new Acc()), efforts: efforts.map(() => new Acc()) }));
  const week = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => new Acc()));
  const byAccount = dimAccounts.map(() => new Acc());
  for (const c of cells) {
    const b = buckets[lastIndexAtOrBefore(starts, c.hour)]!;
    const ai = accountIndex.get(c.account)!;
    b.total.add(c.tally);
    b.accounts[ai]!.add(c.tally);
    b.models[modelIndex.get(c.model)!]!.add(c.tally);
    b.efforts[effortIndex.get(c.effort)!]!.add(c.tally);
    byAccount[ai]!.add(c.tally);
    const d = new Date(c.hour);
    week[weekdayOf(d)]![d.getHours()]!.add(c.tally);
  }
  const occurrences = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (let h = spanStart; h < spanEnd && h <= cube.generatedAt; h += HOUR_MS) {
    const d = new Date(h);
    occurrences[weekdayOf(d)]![d.getHours()]!++;
  }

  const totalStats = total.stats();
  const emails = new Map(accounts.map((a) => [a.id, a.email]));
  return {
    lens,
    asOf: cube.generatedAt,
    keeperLatestAt: cube.keeperLatestAt,
    catchingUp: cube.catchingUp,
    span: { start: spanStart as Instant, end: spanEnd as Instant },
    dimensions: { accounts: dimAccounts, models, efforts },
    total: totalStats,
    previous: previous && { start: previous.edges[0]! as Instant, end: previous.edges[n]! as Instant, stats: previous.total },
    timeline: buckets.map((b, i): TimeBucket => {
      const t = b.total.stats();
      return {
        start: starts[i]! as Instant,
        end: starts[i + 1]! as Instant,
        partial: starts[i + 1]! > cube.generatedAt,
        total: t,
        previous: previous && { start: previous.edges[i]! as Instant, end: previous.edges[i + 1]! as Instant, stats: previous.buckets[i]! },
        byAccount: parts(dimAccounts.map((a, j) => [a.id, b.accounts[j]!]), t),
        byModel: parts(models.map((m, j) => [m, b.models[j]!]), t),
        byEffort: parts(efforts.map((e, j) => [e, b.efforts[j]!]), t),
      };
    }),
    week: weekGrid(week.map((row, wd) => row.map((acc, hour): WeekCell => ({ weekday: wd as Weekday, hour, occurrences: occurrences[wd]![hour]!, stats: acc.stats() })))),
    byAccount: parts(dimAccounts.map((a, j) => [a.id, byAccount[j]!]), totalStats),
    byModel: parts(models.map((m) => [m, byModel.get(m)!]), totalStats),
    byEffort: parts(efforts.map((e) => [e, byEffort.get(e)!]), totalStats),
    byAccountModel: [...byAccountModel.values()]
      .map((x) => ({ account: x.account, model: x.model, stats: x.acc.stats() }))
      .sort((x, y) => y.stats.requests - x.stats.requests || (emails.get(x.account) ?? '').localeCompare(emails.get(y.account) ?? '') || x.model.localeCompare(y.model)),
    errors: cube.errors
      .filter((e) => e.at !== null && e.at >= spanStart && e.at < spanEnd && e.account !== null && accountIndex.has(e.account) && (lens.model === null || e.model === lens.model))
      .map((e): ErrorEventView => ({ ...e, email: emails.get(e.account!) ?? null })),
  };
}

/**
 * The buckets one range earlier, by local calendar, as edges (one more than buckets, the last the cut at asOf less the shift)
 * with their stats. Null where PriorSpan says the history cannot match them.
 */
function foldPrevious(cube: UsageCube, range: UsageRange, starts: readonly number[], inLens: (c: UsageCell) => boolean) {
  const n = starts.length - 1;
  const days = Math.round(RANGE_SPAN[range].ms / DAY_MS);
  const back = (t: number) => {
    const d = new Date(t);
    d.setDate(d.getDate() - days);
    return d.getTime();
  };
  const edges = [...starts.slice(0, n).map(back), back(cube.generatedAt)];
  const reachesBack = !cube.catchingUp && edges[0]! >= cube.horizonStart && cube.cells.length > 0 && cube.cells[0]!.hour <= edges[0]! + DAY_MS;
  if (!reachesBack) return null;
  const total = new Acc();
  const buckets = Array.from({ length: n }, () => new Acc());
  for (const c of cube.cells) {
    if (c.hour < edges[0]! || c.hour >= edges[n]! || !inLens(c)) continue;
    total.add(c.tally);
    buckets[lastIndexAtOrBefore(edges, c.hour)]!.add(c.tally);
  }
  return { edges, total: total.stats(), buckets: buckets.map((b) => b.stats()) };
}

const mean = (c: WeekCell) => (c.occurrences === 0 ? 0 : c.stats.requests / c.occurrences);

/** The grid plus what a reader wants off it: the average day, the average hour and the busiest of each. */
function weekGrid(rows: readonly (readonly WeekCell[])[]): WeekGrid {
  const perDay = rows.map((row) => row.reduce((n, c) => n + mean(c), 0));
  const perHour = Array.from({ length: 24 }, (_, h) => {
    const slots = rows.map((row) => row[h]!);
    const occurrences = slots.reduce((n, c) => n + c.occurrences, 0);
    return occurrences === 0 ? 0 : slots.reduce((n, c) => n + c.stats.requests, 0) / occurrences;
  });
  const busiestDay = perDay.indexOf(Math.max(...perDay));
  const window = (from: number) => perHour[from]! + perHour[(from + 1) % 24]! + perHour[(from + 2) % 24]!;
  const busiestFrom = perHour.map((_, h) => h).reduce((best, h) => (window(h) > window(best) ? h : best), 0);
  const empty = perDay.every((n) => n === 0);
  return { rows, perDay, perHour, peak: empty ? null : { weekday: busiestDay as Weekday, hours: { from: busiestFrom, to: (busiestFrom + 3) % 24 } } };
}

const NEEDS_BAR: Readonly<Record<PaceOutlook['kind'], boolean>> = { hits: true, at_limit: true, lasts: false, too_early: false };

function derivePace(cube: UsageCube, accounts: readonly AccountView[]): PaceAccountView[] {
  return accounts.flatMap((a) => {
    const windows = a.limits.flatMap((l): PaceView[] => {
      if (l.pace === null) return [];
      const from = Math.floor(l.pace.startsAt / HOUR_MS) * HOUR_MS;
      const spent = new Acc();
      for (const c of cube.cells) if (c.account === a.id && c.hour >= from) spent.add(c.tally);
      const s = spent.stats();
      const used = l.pace.used;
      return [
        {
          account: a.id,
          email: a.email,
          limit: { key: l.key, label: l.label },
          pace: l.pace,
          spent: s,
          perPercent: used < 1 ? null : { requests: s.requests / used, output: s.tokens.output / used, freshInput: s.tokens.freshInput / used },
        },
      ];
    });
    if (windows.length === 0) return [];
    return [{ account: a.id, email: a.email, attention: windows.filter((w) => NEEDS_BAR[w.pace.outlook.kind]), steady: windows.filter((w) => !NEEDS_BAR[w.pace.outlook.kind]) }];
  });
}

/** Sums Tallies into UsageStats. Histograms merge into dense arrays, allocated only when a tally has bins. */
class Acc {
  private readonly outcomes: Record<Outcome, number> = { ok: 0, rate_limited: 0, client_closed: 0, server_error: 0, other_error: 0 };
  private readonly tokens = { freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0 };
  private sessions = 0;
  private latency: Float64Array | null = null;
  private ttft: Float64Array | null = null;

  add(t: Tally): void {
    for (const o of OUTCOMES) this.outcomes[o] += t.outcomes[o];
    for (const k of Object.keys(this.tokens) as (keyof TokenSums)[]) this.tokens[k] += t.tokens[k];
    this.sessions += t.sessionsStarted;
    if (t.latencyMs.length > 0) merge((this.latency ??= new Float64Array(LATENCY_SCALE.bins)), t.latencyMs);
    if (t.ttftMs.length > 0) merge((this.ttft ??= new Float64Array(LATENCY_SCALE.bins)), t.ttftMs);
  }

  requests(): number {
    return OUTCOMES.reduce((n, o) => n + this.outcomes[o], 0);
  }

  stats(): UsageStats {
    const requests = this.requests();
    const { freshInput, cacheRead, cacheCreation, output } = this.tokens;
    const input = freshInput + cacheRead + cacheCreation;
    return {
      requests,
      outcomes: { ...this.outcomes },
      rates: requests === 0 ? null : (Object.fromEntries(OUTCOMES.map((o) => [o, this.outcomes[o] / requests])) as Record<Outcome, number>),
      tokens: { ...this.tokens },
      cacheReadShare: input === 0 ? null : cacheRead / input,
      cacheMissShare: input === 0 ? null : (freshInput + cacheCreation) / input,
      outputPerRequest: requests === 0 ? null : output / requests,
      sessions: this.sessions,
      outputPerSession: this.sessions === 0 ? null : output / this.sessions,
      latencyMs: percentiles(this.latency),
      ttftMs: percentiles(this.ttft),
    };
  }
}

function merge(dense: Float64Array, h: Histogram): void {
  for (const [bin, count] of h) dense[bin]! += count;
}

/** Each quantile is interpolated inside its bin on the log scale, so it lies in the bin of the true value, within 19% of it. */
function percentiles(dense: Float64Array | null): Percentiles | null {
  if (dense === null) return null;
  const samples = dense.reduce((a, b) => a + b, 0);
  if (samples < MIN_SAMPLES) return null;
  const { floorMs, binsPerDoubling } = LATENCY_SCALE;
  const at = (q: number) => {
    const rank = q * samples;
    let below = 0;
    for (let i = 0; i < dense.length; i++) {
      const c = dense[i]!;
      if (c > 0 && below + c >= rank) return Math.round(floorMs * 2 ** ((i + (rank - below) / c) / binsPerDoubling));
      below += c;
    }
    return Math.round(floorMs * 2 ** (dense.length / binsPerDoubling));
  };
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), samples };
}

function parts<K>(entries: readonly (readonly [K, Acc])[], parent: UsageStats): Part<K>[] {
  return entries.map(([key, acc]) => {
    const stats = acc.stats();
    return {
      key,
      stats,
      share: parent.requests === 0 ? null : { requests: stats.requests / parent.requests, output: parent.tokens.output === 0 ? 0 : stats.tokens.output / parent.tokens.output },
    };
  });
}

/**
 * Bucket edges, one more than buckets, the last past asOf. hour: from the top of asOf's hour back n − 1 hours, through
 * the next top of the hour. day: local midnights by calendar date, so a DST day is 23 or 25 hours long.
 */
function bucketStarts(range: UsageRange, grain: Grain, asOf: Instant): number[] {
  const starts: number[] = [];
  if (grain === 'hour') {
    const top = Math.floor(asOf / HOUR_MS) * HOUR_MS;
    for (let i = Math.round(RANGE_SPAN[range].ms / HOUR_MS) - 1; i >= -1; i--) starts.push(top - i * HOUR_MS);
  } else {
    const d = new Date(asOf);
    for (let i = Math.round(RANGE_SPAN[range].ms / DAY_MS) - 1; i >= -1; i--) starts.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime());
  }
  return starts;
}

function lastIndexAtOrBefore(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const weekdayOf = (d: Date) => ((d.getDay() + 6) % 7) as Weekday;

function effortOrder(a: Effort, b: Effort): number {
  const rank = (e: Effort) => (e === '' ? EFFORT_LADDER.length + 1 : EFFORT_LADDER.includes(e) ? EFFORT_LADDER.indexOf(e) : EFFORT_LADDER.length);
  return rank(a) - rank(b) || a.localeCompare(b);
}

function getOr<K, V>(m: Map<K, V>, key: K, make: () => V): V {
  let v = m.get(key);
  if (v === undefined) m.set(key, (v = make()));
  return v;
}
