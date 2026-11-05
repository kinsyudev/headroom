process.env.TZ = 'Europe/Madrid';

import { describe, expect, test } from 'bun:test';
import { deriveDeck, mergeLimits } from '../src/shared/derive';
import type { AccountId, Instant, Limit, Outcome, Percent } from '../src/shared/domain';
import { HORIZON_MS, latencyBin, deriveAnalytics, type ErrorEvent, type Tally, type UsageCell, type UsageCube } from '../src/shared/usage';
import type { AccountView, AnalyticsLens } from '../src/shared/view';
import { ACC1, ACC2, ACC3, at, snapshot } from './support';

const NOW = at('2026-11-04T13:00:00Z');
const HOUR = 3_600_000;
const accounts = deriveDeck(snapshot({ now: NOW }), NOW).accounts;

function tally(t: { readonly outcomes?: Partial<Record<Outcome, number>>; readonly output?: number; readonly cacheRead?: number; readonly freshInput?: number; readonly cacheCreation?: number; readonly sessions?: number; readonly latency?: readonly (readonly [number, number])[] } = {}): Tally {
  return {
    outcomes: { ok: 0, rate_limited: 0, client_closed: 0, server_error: 0, other_error: 0, ...(t.outcomes ?? { ok: 1 }) },
    tokens: { freshInput: t.freshInput ?? 0, cacheRead: t.cacheRead ?? 0, cacheCreation: t.cacheCreation ?? 0, output: t.output ?? 0, reasoning: 0 },
    sessionsStarted: t.sessions ?? 0,
    latencyMs: (t.latency ?? []).map(([ms, n]) => [latencyBin(ms), n] as const),
    ttftMs: [],
  };
}
const cell = (iso: string, account: AccountId, t: Tally = tally(), model = 'claude-opus-5-5', effort = 'high'): UsageCell => ({ hour: at(iso), account, model, effort, tally: t });
const ok = (n: number) => tally({ outcomes: { ok: n } });
const cube = (cells: readonly UsageCell[], over: Partial<UsageCube> = {}): UsageCube => ({
  generatedAt: NOW,
  horizonStart: (NOW - HORIZON_MS) as Instant,
  catchingUp: false,
  keeperLatestAt: null,
  cells: [...cells].sort((a, b) => a.hour - b.hour),
  errors: [],
  ...over,
});
const view = (cells: readonly UsageCell[], lens: AnalyticsLens = { range: '24h' }, over: Partial<UsageCube> = {}, accts: readonly AccountView[] = accounts) => deriveAnalytics(cube(cells, over), lens, accts);

describe('buckets in the browser time zone', () => {
  test('30d day buckets step by local date, so the DST day is 25 hours', () => {
    const v = view([cell('2026-10-24T22:00:00Z', ACC1), cell('2026-10-25T22:00:00Z', ACC1, ok(2)), cell('2026-10-25T23:00:00Z', ACC1, ok(4))], { range: '30d' });
    expect(v.lens.grain).toBe('day');
    expect(v.timeline).toHaveLength(30);
    const lengths = v.timeline.map((b) => (b.end - b.start) / HOUR);
    expect(lengths.filter((h) => h === 25)).toHaveLength(1);
    expect(lengths.filter((h) => h === 24)).toHaveLength(29);
    const dst = v.timeline.find((b) => b.end - b.start === 25 * HOUR)!;
    expect(new Date(dst.start).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(dst.total.requests).toBe(3);
    expect(v.timeline[v.timeline.indexOf(dst) + 1]!.total.requests).toBe(4);
    expect(v.timeline.at(-1)!.end).toBeGreaterThan(NOW);
  });

  test('24h: 24 contiguous hours ending in the current one; older hours are dropped', () => {
    const v = view([cell('2026-11-04T12:00:00Z', ACC1, ok(5)), cell('2026-11-03T12:00:00Z', ACC2)]);
    expect(v.lens.grain).toBe('hour');
    expect(v.timeline).toHaveLength(24);
    expect(v.timeline.at(-1)!.start).toBe(NOW);
    expect(v.timeline.every((b, i) => i === 0 || b.start === v.timeline[i - 1]!.end)).toBe(true);
    expect(v.timeline.at(-2)!.total.requests).toBe(5);
    expect(v.total.requests).toBe(5);
  });

  test.each(['24h', '7d', '30d'] as const)('%s: only the bucket still running at asOf is partial', (range) => {
    for (const asOf of [NOW, NOW + 1, NOW + 59 * 60_000]) {
      const marked = view([], { range }, { generatedAt: asOf as Instant }).timeline.map((b) => b.partial);
      expect(marked.at(-1)).toBe(true);
      expect(marked.slice(0, -1).some(Boolean)).toBe(false);
    }
  });

  test('a bucket that ends exactly at asOf is complete and the next one is partial', () => {
    const { timeline } = view([]);
    expect(timeline.at(-2)!.end).toBe(NOW);
    expect(timeline.at(-2)!.partial).toBe(false);
    expect(timeline.at(-1)!.partial).toBe(true);
  });

  test('7d by the hour gives 168 buckets', () => {
    expect(view([], { range: '7d', grain: 'hour' }).timeline).toHaveLength(168);
  });
});

describe('breakdowns', () => {
  const cells = [
    cell('2026-11-04T10:00:00Z', ACC1, ok(1), 'claude-sonnet-5-5', 'max'),
    cell('2026-11-04T10:00:00Z', ACC1, ok(5), 'claude-opus-5-5', ''),
    cell('2026-11-04T11:00:00Z', ACC3, ok(2), 'claude-opus-5-5', 'turbo'),
    cell('2026-11-04T11:00:00Z', ACC3, ok(1), 'claude-fable-5-1', 'medium'),
    cell('2026-11-04T12:00:00Z', ACC3, ok(1), 'claude-sonnet-5', 'none'),
  ];

  test('series line up with the dimensions in every bucket: accounts in deck order and zero-filled, models by requests, efforts by the ladder', () => {
    const v = view(cells);
    expect(v.dimensions.accounts.map((a) => a.email)).toEqual(['account1@example.com', 'account2@example.com', 'account3@example.com']);
    expect(v.dimensions.models).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-sonnet-5-5']);
    expect(v.dimensions.efforts).toEqual(['none', 'medium', 'max', 'turbo', '']);
    for (const b of v.timeline) {
      expect(b.byAccount.map((p) => p.key)).toEqual([ACC1, ACC2, ACC3]);
      expect(b.byModel.map((p) => p.key)).toEqual([...v.dimensions.models]);
      expect(b.byEffort.map((p) => p.key)).toEqual([...v.dimensions.efforts]);
    }
    const ten = v.timeline.find((b) => b.start === at('2026-11-04T10:00:00Z'))!;
    expect(ten.byAccount.map((p) => p.stats.requests)).toEqual([6, 0, 0]);
    expect(ten.byAccount[0]!.share).toEqual({ requests: 1, output: 0 });
    expect(v.byAccount.map((p) => p.stats.requests)).toEqual([6, 0, 4]);
    expect(v.byAccountModel.map((r) => [r.account, r.model, r.stats.requests])).toEqual([
      [ACC1, 'claude-opus-5-5', 5],
      [ACC3, 'claude-opus-5-5', 2],
      [ACC1, 'claude-sonnet-5-5', 1],
      [ACC3, 'claude-fable-5-1', 1],
      [ACC3, 'claude-sonnet-5', 1],
    ]);
  });

  test('an account lens narrows every figure and the dimensions; a model lens narrows the figures', () => {
    const one = view(cells, { range: '24h', account: ACC3 });
    expect(one.dimensions.accounts.map((a) => a.id)).toEqual([ACC3]);
    expect(one.total.requests).toBe(4);
    const opus = view(cells, { range: '24h', model: 'claude-opus-5-5' });
    expect(opus.total.requests).toBe(7);
    expect(opus.dimensions.models).toEqual(['claude-opus-5-5']);
  });

  test('ratios: outcome rates, cache-read share of input, output per request and per session', () => {
    const v = view([cell('2026-11-04T12:00:00Z', ACC1, tally({ outcomes: { ok: 3, rate_limited: 1 }, freshInput: 10, cacheRead: 970, cacheCreation: 20, output: 400, sessions: 2 }))]);
    expect(v.total.rates).toMatchObject({ ok: 0.75, rate_limited: 0.25, client_closed: 0 });
    expect(v.total.cacheReadShare).toBe(0.97);
    expect(v.total.outputPerRequest).toBe(100);
    expect(v.total.outputPerSession).toBe(200);
    expect(view([]).total).toMatchObject({ requests: 0, rates: null, cacheReadShare: null, outputPerRequest: null, outputPerSession: null, latencyMs: null });
  });
});

describe('latency percentiles from bins', () => {
  test('merged across cells, each in the bin of the true value, within 19% of it', () => {
    const v = view([cell('2026-11-04T11:00:00Z', ACC1, tally({ latency: [[1_000, 50]] })), cell('2026-11-04T12:00:00Z', ACC3, tally({ latency: [[10_000, 50]] }))]);
    const p = v.total.latencyMs!;
    expect(p.samples).toBe(100);
    const binWidth = 2 ** (1 / 4);
    expect(p.p90 / 10_000).toBeGreaterThan(1 / binWidth);
    expect(p.p90 / 10_000).toBeLessThan(binWidth);
    expect(p.p50 / 1_000).toBeGreaterThan(1 / binWidth);
    expect(p.p50 / 1_000).toBeLessThan(binWidth);
  });

  test('under 20 samples there is no percentile', () => {
    expect(view([cell('2026-11-04T12:00:00Z', ACC1, tally({ latency: [[5_000, 19]] }))]).total.latencyMs).toBeNull();
    expect(view([cell('2026-11-04T12:00:00Z', ACC1, tally({ latency: [[5_000, 20]] }))]).total.latencyMs?.samples).toBe(20);
  });
});

describe('weekday by hour', () => {
  test('a cell lands on its local weekday and hour, and each slot counts how often it began in the span', () => {
    const monday14 = '2026-11-02T13:00:00Z';
    const week = view([cell(monday14, ACC1, ok(3))], { range: '7d' }).week;
    expect(week.rows).toHaveLength(7);
    expect(week.rows.every((r) => r.length === 24)).toBe(true);
    expect(week.rows[0]![14]!.stats.requests).toBe(3);
    expect(week.rows[0]![14]!.occurrences).toBe(1);
    expect(week.rows[2]![14]!.occurrences).toBe(1);
    expect(week.rows[2]![15]!.occurrences).toBe(0);
    const month = view([], { range: '30d' }).week;
    expect(month.rows[0]![9]!.occurrences).toBe(4);
    expect(month.rows[1]![9]!.occurrences).toBe(5);
  });
});

describe('errors', () => {
  const error = (id: number, iso: string, account: AccountId | null, model = 'claude-opus-5-5'): ErrorEvent => ({
    id,
    at: at(iso),
    account,
    model,
    status: 429,
    outcome: 'rate_limited',
    quotaReason: 'credential_quota',
    recoverAt: null,
    message: 'rate limited',
  });
  const errors = [error(4, '2026-11-04T12:30:00Z', ACC3), error(3, '2026-11-04T12:00:00Z', 'ffffffffffffffff' as AccountId), error(2, '2026-11-04T11:00:00Z', ACC1, 'claude-sonnet-5-5'), error(1, '2026-11-01T09:00:00Z', ACC1)];

  test('inside the span, for known accounts, matching the lens, newest first, with the email', () => {
    expect(view([], { range: '24h' }, { errors }).errors.map((e) => [e.id, e.email])).toEqual([
      [4, 'account3@example.com'],
      [2, 'account1@example.com'],
    ]);
    expect(view([], { range: '7d' }, { errors }).errors.map((e) => e.id)).toEqual([4, 2, 1]);
    expect(view([], { range: '7d', model: 'claude-sonnet-5-5' }, { errors }).errors.map((e) => e.id)).toEqual([2]);
  });
});

describe('pace joins the quota window with what it has cost', () => {
  const session = (used: number, resetsInMs: number): Limit => ({ kind: 'session', percent: used as Percent, severity: 'normal', resetsAt: (NOW + resetsInMs) as Instant, scopeModel: null, isActive: true });
  const withLimits = (id: AccountId, limits: readonly Limit[]): AccountView[] =>
    accounts.map((a) => (a.id === id ? { ...a, limits: mergeLimits({ value: limits, at: NOW }, null, NOW) } : { ...a, limits: [] }));
  const cells = [
    cell('2026-11-04T10:00:00Z', ACC1, ok(100)),
    cell('2026-11-04T11:00:00Z', ACC1, tally({ outcomes: { ok: 6 }, output: 900 })),
    cell('2026-11-04T12:00:00Z', ACC1, tally({ outcomes: { ok: 4 }, output: 300 }), 'claude-sonnet-5-5'),
    cell('2026-11-04T12:00:00Z', ACC3, ok(50)),
  ];

  test('spent counts every model on the account from the hour the window opened; perPercent divides by what is used', () => {
    const v = view(cells, { range: '24h', model: 'claude-opus-5-5' }, {}, withLimits(ACC1, [session(40, 3 * HOUR)]));
    expect(v.pace).toHaveLength(1);
    const p = v.pace[0]!;
    expect(p).toMatchObject({ account: ACC1, email: 'account1@example.com', limit: { key: 'session', label: 'Session' } });
    expect(p.pace.startsAt).toBe(at('2026-11-04T11:00:00Z'));
    expect(p.spent.requests).toBe(10);
    expect(p.perPercent).toEqual({ requests: 10 / 40, output: 1_200 / 40, freshInput: 0 });
  });

  test('under 1% used there is no cost per percent, and an account lens keeps only its own windows', () => {
    expect(view(cells, { range: '24h' }, {}, withLimits(ACC1, [session(0.5, 3 * HOUR)])).pace[0]!.perPercent).toBeNull();
    expect(view(cells, { range: '24h', account: ACC3 }, {}, withLimits(ACC1, [session(40, 3 * HOUR)])).pace).toEqual([]);
  });
});

test('catchingUp and the keeper timestamp pass through', () => {
  const v = view([], { range: '24h' }, { catchingUp: true, keeperLatestAt: at('2026-11-04T12:59:00Z') });
  expect(v.catchingUp).toBe(true);
  expect(v.keeperLatestAt).toBe(at('2026-11-04T12:59:00Z'));
  expect(v.asOf).toBe(NOW);
});
