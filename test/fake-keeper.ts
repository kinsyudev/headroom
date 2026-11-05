import { Database, type Statement } from 'bun:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HORIZON_MS } from '../src/shared/usage';

const SCHEMA = readFileSync(join(import.meta.dir, 'fixtures/keeper-schema.sql'), 'utf8');
const ids = [1, 2, 3].map((n) => readFileSync(join(import.meta.dir, `fixtures/auth-index-${n}.txt`), 'utf8').trim());
export const [KEEPER_ACC2, KEEPER_ACC1, KEEPER_ACC3] = ids as [string, string, string];

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const FAKE_SEED = 0x2611_05;
/** The feed inserts on wall-clock multiples of this. At instant t, every fake DB holds exactly the rows timestamped before floor(t / tick) · tick. */
export const FEED_TICK_MS = 10_000;
/** What createKeeperDb writes: Headroom's horizon plus a day. */
export const FAKE_HISTORY_MS = HORIZON_MS + DAY;

export interface FakeOptions {
  readonly seed: number;
  /** The fixed UTC offset the operator lives in. Day and hour patterns follow it. */
  readonly zoneOffsetMin: number;
  /** Mean requests per day across the week, before the account1 keep-alive. */
  readonly requestsPerDay: number;
}

const DEFAULTS: FakeOptions = { seed: FAKE_SEED, zoneOffsetMin: 60, requestsPerDay: 3_250 };

/** keeper's columns as the fake writes them. `failed` is not a field: insertUsage derives it from status, so the two always agree. */
export interface UsageRow {
  readonly at: number;
  readonly account: string;
  readonly model: string;
  readonly status?: number;
  /** keeper's input_tokens, which includes cacheRead and cacheCreation. */
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly latencyMs?: number | null;
  readonly ttftMs?: number | null;
  readonly effort?: string;
  readonly session?: string | null;
}

export interface ErrorEventRow {
  readonly at: number;
  readonly account: string;
  readonly model: string;
  readonly status: number;
  readonly body: string;
  readonly quotaReason: string | null;
  readonly recoverAt: number | null;
}

/**
 * The fake history. It is pure and time-indexed: the rows depend only on (options, from, to), never on when or where
 * it runs. usage(a, c) equals [...usage(a, b), ...usage(b, c)] for any a ≤ b ≤ c, and errors() obeys the same law.
 * Every 429 and 5xx usage row has an error_events row at its response instant (at + latency), on the same account and model.
 */
export interface Timeline {
  usage(from: number, to: number): readonly UsageRow[];
  errors(from: number, to: number): readonly ErrorEventRow[];
}

// Calibration, measured read-only on the live keeper DB on 2026-11-05 (150k rows over 37 days). Rerun with
// `bun scripts/keeper-profile.ts` to compare the live DB and the fake through the same profile().

/** Mean requests per local day relative to the mean day, Monday first. */
const WEEKDAY_WEIGHT = [1.3, 0.97, 1.52, 1.24, 0.94, 0.44, 0.59] as const;
/** Percent of requests per local hour of day, 00 to 23. */
const HOUR_SHARE = [8.5, 4.8, 2.5, 2.2, 1.9, 0.9, 0.4, 0.4, 0.5, 0.4, 2.1, 2.8, 3.5, 6.3, 7.1, 6.2, 6.8, 5.9, 5.5, 7.8, 5.1, 5.5, 6.6, 6.2] as const;
/** A day block starts in the overnight trough, so no session crosses a block. */
const BLOCK_START_HOUR = 5;
const DAY_NOISE_SIGMA = 0.3;
/**
 * Session share per account. With the keep-alive on top, requests land 61/27/12, the live split over the last 30 days
 * largest first. account1 is the fake CPA's fill-first target.
 */
const ACCOUNT_SHARE: readonly (readonly [string, number])[] = [
  [KEEPER_ACC1, 0.54],
  [KEEPER_ACC2, 0.32],
  [KEEPER_ACC3, 0.14],
];

interface ModelProfile {
  readonly model: string;
  readonly weight: number;
  readonly efforts: readonly (readonly [string, number])[];
  readonly outputMedian: number;
  readonly outputSigma: number;
  readonly tokensPerSecond: number;
}

/**
 * Session model and effort, and output medians from ok rows. Weights sit below the live request shares (opus 86.7%,
 * high 35%) by what the opus/high keep-alive adds.
 */
const MODELS: readonly ModelProfile[] = [
  { model: 'claude-opus-5-5', weight: 0.825, efforts: [['high', 29], ['xhigh', 33], ['max', 18], ['medium', 19], ['', 1]], outputMedian: 409, outputSigma: 1.18, tokensPerSecond: 85 },
  { model: 'claude-sonnet-5-5', weight: 0.127, efforts: [['medium', 56], ['xhigh', 44]], outputMedian: 461, outputSigma: 1.2, tokensPerSecond: 140 },
  { model: 'claude-fable-5-1', weight: 0.031, efforts: [['high', 64], ['xhigh', 18], ['', 9], ['medium', 9]], outputMedian: 638, outputSigma: 1.3, tokensPerSecond: 80 },
  { model: 'claude-sonnet-5', weight: 0.0145, efforts: [['none', 98], ['medium', 2]], outputMedian: 9, outputSigma: 0.2, tokensPerSecond: 140 },
  { model: 'claude-haiku-5-5', weight: 0.0018, efforts: [['', 50], ['medium', 50]], outputMedian: 300, outputSigma: 1, tokensPerSecond: 200 },
];
const OPUS = MODELS[0]!;

/** reasoning_tokens ÷ output_tokens per effort. */
const REASONING_SHARE: Readonly<Record<string, number>> = { none: 0, low: 0.07, medium: 0.26, high: 0.35, xhigh: 0.53, max: 0.69, '': 0.28 };

const SESSION_SIZE = { median: 27, sigma: 0.95, max: 800 } as const;
/** Start-to-start gaps inside a session (p50 6.8 s, p90 36 s). An idle gap outlives the 5-minute prompt cache. */
const GAP = { medianMs: 6_800, sigma: 1.25, maxMs: 4 * MINUTE, idleChance: 0.012, idleMinMs: 6 * MINUTE, idleMaxMs: 40 * MINUTE } as const;
const CACHE_TTL_MS = 5 * MINUTE;
const CONTEXT = { startMedian: 32_000, deltaMedian: 1_300, deltaSigma: 1.17, deltaMax: 180_000, compactMin: 480_000, compactMax: 700_000, compactTo: 45_000 } as const;
const FRESH_INPUT = 2;

const CLIENT_CLOSED_CHANCE = 0.0018;
/** 5xx come mostly in incident windows. */
const INCIDENT = { chance: 0.3, medianMs: 2 * HOUR, sigma: 0.8, rate: 0.012, baseRate: 0.0002 } as const;
const SERVER_STATUS: readonly (readonly [number, number])[] = [
  [500, 87],
  [503, 6.5],
  [529, 6.5],
];
/** account3 hits its limit about every third day. The 429s come in a burst at one instant, then its session fails over to account1. */
const WALL = { chance: 1 / 3, burstMax: 3, recoverMinMs: 110 * MINUTE, recoverMaxMs: 240 * MINUTE } as const;
/**
 * account1 keeps a successful request at most this far apart, so it reads as serving at any hour: the gap, plus up to
 * one feed tick (10 s) and one serving read (5 s), stays under SERVING_WINDOW_MS (120 s).
 */
export const KEEP_ALIVE_GAP_MS = 100 * SECOND;
const MAX_ERROR_LAG_MS = 2 * MINUTE;

const ERROR_BODY: Readonly<Record<number, string>> = {
  429: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account’s rate limit. Please try again later.' } }),
  500: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }),
  503: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Service unavailable' } }),
  529: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
};

interface Block {
  readonly usage: readonly UsageRow[];
  readonly errors: readonly ErrorEventRow[];
}

/**
 * The history is generated in day blocks that start at 05:00 local, in the overnight trough. Each block is seeded by
 * hash(seed, blockIndex) and generated once per timeline.
 */
export function fakeTimeline(opts: Partial<FakeOptions> = {}): Timeline {
  const o = { ...DEFAULTS, ...opts };
  const anchor = BLOCK_START_HOUR * HOUR - o.zoneOffsetMin * MINUTE;
  const blocks = new Map<number, Block>();
  const block = (k: number) => {
    let b = blocks.get(k);
    if (!b) blocks.set(k, (b = generateBlock(anchor + k * DAY, o)));
    return b;
  };
  const indexOf = (t: number) => Math.floor((t - anchor) / DAY);
  const collect = <R extends { readonly at: number }>(from: number, to: number, lag: number, pick: (b: Block) => readonly R[]): R[] => {
    const out: R[] = [];
    if (to <= from) return out;
    for (let k = indexOf(from - lag); k <= indexOf(to - 1); k++) {
      const rows = pick(block(k));
      for (let i = lowerBound(rows, from); i < rows.length && rows[i]!.at < to; i++) out.push(rows[i]!);
    }
    return out;
  };
  return {
    usage: (from, to) => collect(from, to, 0, (b) => b.usage),
    errors: (from, to) => collect(from, to, MAX_ERROR_LAG_MS, (b) => b.errors).sort((x, y) => x.at - y.at),
  };
}

function generateBlock(start: number, o: FakeOptions): Block {
  const end = start + DAY;
  const r = rng(hash(o.seed, Math.round(start / HOUR)));
  const weekday = (new Date(start + o.zoneOffsetMin * MINUTE).getUTCDay() + 6) % 7;
  const target = o.requestsPerDay * WEEKDAY_WEIGHT[weekday]! * lognormal(r, 1, DAY_NOISE_SIGMA);
  const incidentStart = start + r() * DAY;
  const incident = r() < INCIDENT.chance ? { from: incidentStart, to: incidentStart + lognormal(r, INCIDENT.medianMs, INCIDENT.sigma) } : null;
  const wall = r() < WALL.chance;

  const sessions: Draft[][] = [];
  for (let total = 0; total < target; ) {
    const s = session(r, start, end, incident);
    sessions.push(s);
    total += s.length;
  }
  const rows = sessions.flat();
  if (wall) rows.push(...wallEpisode(r, sessions));
  rows.push(...keepAlive(r, start, end, rows));
  const usage = rows.sort((x, y) => x.at - y.at);
  const errors = usage
    .filter((u) => u.status === 429 || u.status! >= 500)
    .map(
      (u): ErrorEventRow => ({
        at: u.at + u.latencyMs!,
        account: u.account,
        model: u.model,
        status: u.status!,
        body: ERROR_BODY[u.status!]!,
        quotaReason: u.status === 429 ? 'credential_quota' : null,
        recoverAt: u.status === 429 ? u.at + Math.round(WALL.recoverMinMs + r() * (WALL.recoverMaxMs - WALL.recoverMinMs)) : null,
      }),
    )
    .sort((x, y) => x.at - y.at);
  return { usage, errors };
}

interface Draft extends UsageRow {
  readonly status: number;
  readonly latencyMs: number;
}

function session(r: Rand, start: number, end: number, incident: { from: number; to: number } | null): Draft[] {
  const hour = pick(r, HOUR_SHARE.map((share, h) => [(h - BLOCK_START_HOUR + 24) % 24, share] as const));
  const account = pick(r, ACCOUNT_SHARE);
  const m = pick(r, MODELS.map((p) => [p, p.weight] as const));
  const effort = pick(r, m.efforts);
  const size = Math.min(SESSION_SIZE.max, Math.max(1, Math.round(lognormal(r, SESSION_SIZE.median, SESSION_SIZE.sigma))));
  const id = uuid(r);
  const rows: Draft[] = [];
  let at = start + hour * HOUR + Math.floor(r() * HOUR);
  let context = Math.round(lognormal(r, CONTEXT.startMedian, 0.3));
  let compactAt = CONTEXT.compactMin + r() * (CONTEXT.compactMax - CONTEXT.compactMin);
  let cached = false;
  let lastAt = -Infinity;
  for (let i = 0; i < size && at < end; i++) {
    const warm = cached && at - lastAt < CACHE_TTL_MS;
    const delta = Math.round(Math.min(CONTEXT.deltaMax, lognormal(r, CONTEXT.deltaMedian, CONTEXT.deltaSigma)));
    let cacheRead = warm ? context : 0;
    let cacheCreation = warm ? delta : context + delta;
    context += delta;
    if (context > compactAt) {
      context = CONTEXT.compactTo + Math.round(r() * 10_000);
      cacheRead = 0;
      cacheCreation = context;
      compactAt = CONTEXT.compactMin + r() * (CONTEXT.compactMax - CONTEXT.compactMin);
    }
    const output = Math.max(1, Math.round(lognormal(r, m.outputMedian, m.outputSigma)));
    const ttft = Math.max(150, Math.round((600 + (cacheRead + cacheCreation) * 0.0042) * lognormal(r, 1, 0.42)));
    const latency = Math.round(150 + ttft + (output / m.tokensPerSecond) * SECOND * lognormal(r, 1, 0.25));
    const base = { at, account, model: m.model, effort, session: id, input: cacheRead + cacheCreation + FRESH_INPUT, cacheRead, cacheCreation };
    const failChance = incident && at >= incident.from && at < incident.to ? INCIDENT.rate : INCIDENT.baseRate;
    const u = r();
    if (u < failChance) {
      const status = pick(r, SERVER_STATUS);
      rows.push(({ ...base, status, input: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0, ttftMs: 0, latencyMs: Math.round(Math.min(MAX_ERROR_LAG_MS - SECOND, lognormal(r, 18_000, 0.6))) }));
      cached = false;
    } else if (u < failChance + CLIENT_CLOSED_CHANCE) {
      const cut = Math.round(lognormal(r, 3_000, 1));
      rows.push(({ ...base, status: 499, output: Math.floor(r() * 20), reasoning: 0, ttftMs: cut > ttft ? ttft : null, latencyMs: cut }));
      cached = true;
    } else {
      rows.push(({ ...base, status: 200, output, reasoning: Math.round(output * (REASONING_SHARE[effort] ?? 0)), ttftMs: ttft, latencyMs: latency }));
      cached = true;
    }
    lastAt = at;
    at += r() < GAP.idleChance ? GAP.idleMinMs + r() * (GAP.idleMaxMs - GAP.idleMinMs) : Math.min(GAP.maxMs, lognormal(r, GAP.medianMs, GAP.sigma));
    at = Math.round(at);
  }
  return rows;
}

/** One account3 session hits the wall: a burst of 429s at one instant, then the rest of the session lands on account1. */
function wallEpisode(r: Rand, sessions: Draft[][]): Draft[] {
  const candidates = sessions.filter((s) => s.length >= 4 && s[0]!.account === KEEPER_ACC3);
  const s = candidates[Math.floor(r() * candidates.length)];
  if (!s) return [];
  const j = Math.floor(s.length / 3);
  const at = Math.max(s[j - 1]!.at, s[j]!.at - SECOND);
  for (let i = j; i < s.length; i++) s[i] = { ...s[i]!, account: KEEPER_ACC1 };
  const burst = 1 + Math.floor(r() * WALL.burstMax);
  return Array.from({ length: burst }, () => {
    const latencyMs = Math.round(lognormal(r, 456, 0.3));
    return ({ at, account: KEEPER_ACC3, model: s[j]!.model, effort: s[j]!.effort ?? '', session: s[j]!.session ?? null, status: 429, input: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0, ttftMs: Math.round(latencyMs * 0.8), latencyMs });
  });
}

/**
 * A /loop-style session on account1 that fills every gap between its successful requests longer than KEEP_ALIVE_GAP_MS.
 * It anchors half a gap outside both block edges, so the gap across a block boundary stays under the limit too.
 */
function keepAlive(r: Rand, start: number, end: number, rows: readonly Draft[]): Draft[] {
  const half = KEEP_ALIVE_GAP_MS / 2;
  const times = rows.filter((x) => x.account === KEEPER_ACC1 && x.status === 200).map((x) => x.at);
  const marks = [start - half, ...times.sort((a, b) => a - b), end + half];
  const id = uuid(r);
  const out: Draft[] = [];
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i]! - marks[i - 1]!;
    const n = Math.ceil(gap / KEEP_ALIVE_GAP_MS);
    for (let k = 1; k < n; k++) {
      const output = Math.round(lognormal(r, 120, 0.5));
      const ttftMs = Math.round(lognormal(r, 1_100, 0.3));
      const cacheRead = 40_000 + Math.floor(r() * 8_000);
      out.push(
        ({ at: Math.round(marks[i - 1]! + (gap * k) / n), account: KEEPER_ACC1, model: OPUS.model, effort: 'high', session: id, status: 200, input: cacheRead + 300 + FRESH_INPUT, cacheRead, cacheCreation: 300, output, reasoning: Math.round(output * REASONING_SHARE.high!), ttftMs, latencyMs: ttftMs + Math.round((output / OPUS.tokensPerSecond) * SECOND) }),
      );
    }
  }
  return out;
}

const aligned = (t: number) => Math.floor(t / FEED_TICK_MS) * FEED_TICK_MS;

/**
 * Writes the schema plus the timeline's rows over [aligned(now) − FAKE_HISTORY_MS, aligned(now)), in time order, in one
 * transaction. Returns aligned(now): the instant the DB is complete up to, which is where feedKeeper continues.
 */
export function createKeeperDb(path: string, now = Date.now(), opts: Partial<FakeOptions> = {}): number {
  rmSync(path, { force: true });
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const to = aligned(now);
  write(db, fakeTimeline(opts), to - FAKE_HISTORY_MS, to);
  db.close();
  return to;
}

/**
 * The one live trickle, used by scripts/fake-stack.ts and by `bun test/fake-keeper.ts`. On every FEED_TICK_MS boundary
 * it inserts the timeline rows in [last boundary, this boundary), so the current hour grows at the history's own rate.
 * It catches up at once when the clock is already past `from`.
 */
export function feedKeeper(path: string, opts: Partial<FakeOptions> & { readonly from: number; readonly clock?: () => number }): { stop(): void } {
  const clock = opts.clock ?? Date.now;
  const timeline = fakeTimeline(opts);
  const db = new Database(path);
  let last = opts.from;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const to = aligned(clock());
    if (to > last) {
      write(db, timeline, last, to);
      last = to;
    }
    timer = setTimeout(tick, FEED_TICK_MS - (clock() % FEED_TICK_MS));
  };
  tick();
  return {
    stop() {
      clearTimeout(timer);
      db.close();
    },
  };
}

function write(db: Database, timeline: Timeline, from: number, to: number): void {
  db.transaction(() => {
    for (const r of timeline.usage(from, to)) insertUsage(db, r);
    for (const e of timeline.errors(from, to)) insertError(db, e);
  })();
}

const statements = new WeakMap<Database, { usage: Statement; error: Statement }>();
const prepared = (db: Database) => {
  let s = statements.get(db);
  if (!s) {
    s = {
      usage: db.prepare(
        `INSERT INTO usage_events (timestamp, auth_index, model, provider, reasoning_effort, session_id, failed, status_code, latency_ms, ttft_ms,
           input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens)
         VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      error: db.prepare(
        `INSERT INTO error_events (timestamp, auth_index, model, status_code, body, auth_quota_reason, auth_quota_next_recover_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
    };
    statements.set(db, s);
  }
  return s;
};

/** The one row writer. keeper.test.ts writes hand-made rows through it. */
export function insertUsage(db: Database, r: UsageRow): void {
  const status = r.status ?? 200;
  const input = r.input ?? 0;
  const output = r.output ?? 0;
  prepared(db).usage.run(
    keeperTime(r.at),
    r.account,
    r.model,
    r.effort ?? '',
    r.session ?? null,
    status >= 400 ? 1 : 0,
    status,
    r.latencyMs === undefined ? 1200 : r.latencyMs,
    r.ttftMs === undefined ? 400 : r.ttftMs,
    input,
    output,
    r.reasoning ?? 0,
    r.cacheRead ?? 0,
    r.cacheCreation ?? 0,
    input + output,
  );
}

export function insertError(db: Database, e: ErrorEventRow): void {
  prepared(db).error.run(keeperTime(e.at), e.account, e.model, e.status, e.body, e.quotaReason, e.recoverAt === null ? null : keeperTime(e.recoverAt));
}

/** keeper writes local time in its own zone: 2026-11-04T20:04:26.660000+08:00. */
export function keeperTime(ms: number): string {
  return `${new Date(ms + 8 * HOUR).toISOString().slice(0, 23)}000+08:00`;
}

/** What the fake must look like, measured by profile() over whole weeks. Bands come from the live DB (see the calibration note above). */
export const FAKE_TARGETS = {
  requestsPerDay: { min: 3_500, max: 4_700 },
  sessionsPerDay: { min: 70, max: 115 },
  opusShare: { min: 85, max: 89 },
  cacheReadShare: { min: 96, max: 98 },
  opusLatencyMs: { p50: { min: 4_100, max: 6_900 }, p90: { min: 14_000, max: 24_000 } },
  opusTtftMs: { p50: { min: 870, max: 1_450 }, p90: { min: 1_750, max: 2_900 } },
  clientClosedShare: { min: 0.1, max: 0.3 },
  serverErrorShare: { min: 0.02, max: 0.15 },
} as const;

export interface Profile {
  readonly days: number;
  readonly requestsPerDay: number;
  readonly sessionsPerDay: number;
  /** Percent of requests. */
  readonly modelShare: Readonly<Record<string, number>>;
  readonly accountShare: Readonly<Record<string, number>>;
  readonly effortShare: Readonly<Record<string, number>>;
  readonly statusShare: Readonly<Record<string, number>>;
  /** cacheRead ÷ input, in percent. */
  readonly cacheReadShare: number;
  /** Mean requests per local day, Monday first. */
  readonly weekdayPerDay: readonly number[];
  /** Percent of requests per local hour of day. */
  readonly hourShare: readonly number[];
  readonly opusLatencyMs: { readonly p50: number; readonly p90: number };
  readonly opusTtftMs: { readonly p50: number; readonly p90: number };
}

/** Measures any keeper rows the same way, so the fake and the live DB can be compared (scripts/keeper-profile.ts). */
export function profile(rows: readonly UsageRow[], span: { readonly from: number; readonly to: number }, zoneOffsetMin = DEFAULTS.zoneOffsetMin): Profile {
  const n = rows.length;
  const local = (t: number) => new Date(t + zoneOffsetMin * MINUTE);
  const days = (span.to - span.from) / DAY;
  const percentBy = (key: (x: UsageRow) => string) => {
    const m: Record<string, number> = {};
    for (const x of rows) m[key(x)] = (m[key(x)] ?? 0) + 1;
    for (const k of Object.keys(m)) m[k] = round2((100 * m[k]!) / n);
    return m;
  };
  const weekdayRequests = new Array<number>(7).fill(0);
  const weekdayDays = new Array<number>(7).fill(0);
  const hours = new Array<number>(24).fill(0);
  for (const x of rows) {
    const d = local(x.at);
    weekdayRequests[(d.getUTCDay() + 6) % 7]!++;
    hours[d.getUTCHours()]!++;
  }
  for (let t = span.from; t < span.to; t += DAY) weekdayDays[(local(t + DAY / 2).getUTCDay() + 6) % 7]!++;
  const ok = rows.filter((x) => (x.status ?? 200) < 400 && x.model === OPUS.model);
  const pcts = (values: number[]) => {
    values.sort((a, b) => a - b);
    const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
    return { p50: at(0.5), p90: at(0.9) };
  };
  const sum = (f: (x: UsageRow) => number) => rows.reduce((s, x) => s + f(x), 0);
  return {
    days: round2(days),
    requestsPerDay: Math.round(n / days),
    sessionsPerDay: round2(new Set(rows.map((x) => x.session)).size / days),
    modelShare: percentBy((x) => x.model),
    accountShare: percentBy((x) => x.account),
    effortShare: percentBy((x) => x.effort ?? ''),
    statusShare: percentBy((x) => String(x.status ?? 200)),
    cacheReadShare: round2((100 * sum((x) => x.cacheRead ?? 0)) / sum((x) => x.input ?? 0)),
    weekdayPerDay: weekdayRequests.map((c, i) => Math.round(c / Math.max(1, weekdayDays[i]!))),
    hourShare: hours.map((c) => round2((100 * c) / n)),
    opusLatencyMs: pcts(ok.map((x) => x.latencyMs ?? 0)),
    opusTtftMs: pcts(ok.map((x) => x.ttftMs ?? 0)),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

type Rand = () => number;

/** mulberry32 */
function rng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hash(...xs: readonly number[]): number {
  let h = 2_166_136_261;
  for (const x of xs) {
    h = Math.imul(h ^ (x & 0xffff_ffff), 16_777_619);
    h = Math.imul(h ^ Math.floor(x / 4_294_967_296), 16_777_619);
  }
  return h >>> 0;
}

function lognormal(r: Rand, median: number, sigma: number): number {
  const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return median * Math.exp(sigma * z);
}

function pick<T>(r: Rand, weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let u = r() * total;
  for (const [v, w] of weighted) if ((u -= w) < 0) return v;
  return weighted.at(-1)![0];
}

function uuid(r: Rand): string {
  const hex = Array.from({ length: 4 }, () => Math.floor(r() * 4_294_967_296).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function lowerBound(rows: readonly { readonly at: number }[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.at < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: bun test/fake-keeper.ts <path>');
  feedKeeper(path, { from: createKeeperDb(path) });
  console.log(`fake keeper db at ${path}, fed every ${FEED_TICK_MS / 1000} s`);
}
