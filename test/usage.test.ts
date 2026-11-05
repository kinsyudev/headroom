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
    expect(v.total.cacheMissShare).toBe(0.03);
    expect(v.total.outputPerRequest).toBe(100);
    expect(v.total.outputPerSession).toBe(200);
    expect(view([]).total).toMatchObject({ requests: 0, rates: null, cacheReadShare: null, cacheMissShare: null, outputPerRequest: null, outputPerSession: null, latencyMs: null });
  });

  test('the cache miss share is what written and uncached input add up to, per bucket as well', () => {
    const v = view([
      cell('2026-11-04T11:00:00Z', ACC1, tally({ freshInput: 5, cacheRead: 90, cacheCreation: 5 })),
      cell('2026-11-04T12:00:00Z', ACC1, tally({ freshInput: 30, cacheRead: 60, cacheCreation: 10 })),
    ]);
    expect(v.timeline.at(-3)!.total.cacheMissShare).toBeCloseTo(0.1);
    expect(v.timeline.at(-2)!.total.cacheMissShare).toBeCloseTo(0.4);
    expect(v.timeline.at(-1)!.total.cacheMissShare).toBeNull();
    expect(v.total.cacheMissShare).toBeCloseTo(0.25);
    expect(v.total.cacheMissShare! + v.total.cacheReadShare!).toBeCloseTo(1);
  });
});

describe('the span one range earlier', () => {
  const HALF_PAST = (NOW + 30 * 60_000) as Instant;

  test('7d: each day meets the same local day a week before, and the running day only up to this time of day', () => {
    const v = view(
      [
        cell('2026-10-21T12:00:00Z', ACC1, ok(1_000)),
        cell('2026-10-22T10:00:00Z', ACC1, ok(2)),
        cell('2026-10-24T22:00:00Z', ACC1, ok(11)),
        cell('2026-10-25T22:00:00Z', ACC1, ok(4)),
        cell('2026-10-27T20:00:00Z', ACC2, ok(6)),
        cell('2026-10-28T12:00:00Z', ACC1, ok(3)),
        cell('2026-10-28T13:00:00Z', ACC1, ok(5)),
        cell('2026-10-28T14:00:00Z', ACC1, ok(100)),
        cell('2026-11-04T12:00:00Z', ACC1, ok(40)),
      ],
      { range: '7d' },
      { generatedAt: HALF_PAST },
    );
    const today = v.timeline.at(-1)!;
    expect(today.previous!.stats.requests).toBe(8);
    expect(today.previous!.start).toBe(at('2026-10-27T23:00:00Z'));
    expect(today.previous!.end).toBe(at('2026-10-28T13:30:00Z'));
    expect(v.timeline.at(-2)!.previous!.stats.requests).toBe(6);
    expect(v.timeline[0]!.previous!.stats.requests).toBe(2);
    expect(v.previous!.stats.requests).toBe(2 + 11 + 4 + 6 + 8);
    expect(v.previous!.start).toBe(v.timeline[0]!.previous!.start);
    expect(v.previous!.end).toBe(today.previous!.end);
    expect(v.timeline.reduce((n, b) => n + b.previous!.stats.requests, 0)).toBe(v.previous!.stats.requests);
    expect(v.total.requests).toBe(40);
  });

  test('a day is a calendar day: the 25-hour day of the clocks going back is one bucket, not 24 hours and an hour of the next', () => {
    const v = view([cell('2026-10-22T10:00:00Z', ACC1, ok(2)), cell('2026-10-24T22:00:00Z', ACC1, ok(11)), cell('2026-10-25T22:00:00Z', ACC1, ok(4))], { range: '7d' });
    const nov1 = v.timeline.find((b) => new Date(b.start).getDate() === 1)!;
    expect(nov1.previous!.stats.requests).toBe(15);
    expect((nov1.previous!.end - nov1.previous!.start) / HOUR).toBe(25);
    expect(v.timeline.filter((b) => b !== nov1 && b.previous!.stats.requests > 2)).toEqual([]);
  });

  test('24h: each hour meets the same hour the day before, and the hour holding the cut counts in full', () => {
    const v = view(
      [cell('2026-11-03T12:00:00Z', ACC1, ok(6)), cell('2026-11-03T13:00:00Z', ACC1, ok(50)), cell('2026-11-03T14:00:00Z', ACC1, ok(1_000))],
      { range: '24h' },
      { generatedAt: HALF_PAST },
    );
    expect(v.timeline.at(-2)!.previous!.stats.requests).toBe(6);
    expect(v.timeline.at(-1)!.previous!.stats.requests).toBe(50);
    expect(v.previous!.stats.requests).toBe(56);
  });

  test('the lens narrows the earlier span too', () => {
    const cells = [cell('2026-10-22T10:00:00Z', ACC1, ok(1)), cell('2026-10-28T10:00:00Z', ACC1, ok(3)), cell('2026-10-28T10:00:00Z', ACC2, ok(5), 'claude-sonnet-5-5')];
    expect(view(cells, { range: '7d', account: ACC2 }).previous!.stats.requests).toBe(5);
    expect(view(cells, { range: '7d', model: 'claude-opus-5-5' }).previous!.stats.requests).toBe(4);
  });

  test('30d has nothing to meet, because the history reaches back a month and a day', () => {
    const v = view([cell('2026-10-04T14:00:00Z', ACC1, ok(9))], { range: '30d' });
    expect(v.previous).toBeNull();
    expect(v.timeline.every((b) => b.previous === null)).toBe(true);
  });

  test('without history reaching back to the start of the earlier span, while catching up, or with no history at all, it is null', () => {
    const early = cell('2026-10-22T10:00:00Z', ACC1, ok(2));
    expect(view([early], { range: '7d' }).previous).not.toBeNull();
    expect(view([cell('2026-11-02T12:00:00Z', ACC1, ok(9))], { range: '7d' }).previous).toBeNull();
    expect(view([early], { range: '7d' }, { catchingUp: true }).previous).toBeNull();
    expect(view([], { range: '7d' }).previous).toBeNull();
    expect(view([cell('2026-11-02T12:00:00Z', ACC1, ok(9))], { range: '7d' }).timeline.every((b) => b.previous === null)).toBe(true);
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

  test('the average day and hour, and the heaviest three hours in a row, which may wrap past midnight', () => {
    const lateMonday = ['2026-11-02T22:00:00Z', '2026-11-02T23:00:00Z', '2026-11-03T00:00:00Z'].map((iso) => cell(iso, ACC1, ok(10)));
    const week = view(lateMonday, { range: '7d' }).week;
    expect(week.perDay).toEqual([10, 20, 0, 0, 0, 0, 0]);
    expect(week.perHour[23]).toBeCloseTo(10 / 6);
    expect(week.perHour[0]).toBeCloseTo(10 / 7);
    expect(week.perHour[1]).toBeCloseTo(10 / 7);
    expect(week.perHour[12]).toBe(0);
    expect(week.peak).toEqual({ weekday: 1, hours: { from: 23, to: 2 } });
  });

  test('a slot that occurs twice in the span is a mean per occurrence, not a sum', () => {
    const week = view([cell('2026-11-02T13:00:00Z', ACC1, ok(8))], { range: '30d' }).week;
    expect(week.rows[0]![14]!.occurrences).toBe(4);
    expect(week.perDay[0]).toBe(2);
    expect(week.peak?.weekday).toBe(0);
  });

  test('no requests, no peak', () => {
    expect(view([], { range: '7d' }).week.peak).toBeNull();
  });
});

describe('the error log', () => {
  const error = (id: number, iso: string, account: AccountId | null, over: Partial<ErrorEvent> = {}): ErrorEvent => ({
    id,
    at: at(iso),
    account,
    model: 'claude-opus-5-5',
    status: 429,
    outcome: 'rate_limited',
    quotaReason: 'credential_quota',
    recoverAt: null,
    message: 'rate limited',
    ...over,
  });
  const lines = (errors: readonly ErrorEvent[], lens: AnalyticsLens = { range: '7d' }) => view([], lens, { errors }).errorLog.groups.map((g) => [g.email, g.count, g.lastAt]);

  test('keeps what is inside the span, for known accounts, matching the lens, newest first, with the email', () => {
    const errors = [
      error(4, '2026-11-04T12:30:00Z', ACC3),
      error(3, '2026-11-04T12:00:00Z', 'ffffffffffffffff' as AccountId),
      error(2, '2026-11-04T11:00:00Z', ACC1, { model: 'claude-sonnet-5-5' }),
      error(1, '2026-11-01T09:00:00Z', ACC1),
    ];
    expect(lines(errors, { range: '24h' })).toEqual([
      ['account3@example.com', 1, at('2026-11-04T12:30:00Z')],
      ['account1@example.com', 1, at('2026-11-04T11:00:00Z')],
    ]);
    expect(lines(errors, { range: '7d', model: 'claude-sonnet-5-5' })).toEqual([['account1@example.com', 1, at('2026-11-04T11:00:00Z')]]);
  });

  test('consecutive identical errors on one account are one line with a count and the time of the newest', () => {
    const errors = [
      error(5, '2026-11-04T12:50:00Z', ACC2, { status: 500, outcome: 'server_error', quotaReason: null, message: 'Internal server error' }),
      error(4, '2026-11-04T12:40:00Z', ACC2, { status: 500, outcome: 'server_error', quotaReason: null, message: 'Internal server error' }),
      error(3, '2026-11-04T12:10:00Z', ACC2, { status: 500, outcome: 'server_error', quotaReason: null, message: 'Internal server error' }),
    ];
    expect(lines(errors)).toEqual([['account2@example.com', 3, at('2026-11-04T12:50:00Z')]]);
  });

  test('another account in between does not split a run, and a different error on the same account does', () => {
    const boom = { status: 500, outcome: 'server_error' as const, quotaReason: null, message: 'Internal server error' };
    const errors = [
      error(5, '2026-11-04T12:50:00Z', ACC2, boom),
      error(4, '2026-11-04T12:40:00Z', ACC1, boom),
      error(3, '2026-11-04T12:30:00Z', ACC2, boom),
      error(2, '2026-11-04T12:20:00Z', ACC2, { status: 529, outcome: 'server_error', quotaReason: null, message: 'Overloaded' }),
      error(1, '2026-11-04T12:10:00Z', ACC2, boom),
    ];
    expect(lines(errors)).toEqual([
      ['account2@example.com', 2, at('2026-11-04T12:50:00Z')],
      ['account1@example.com', 1, at('2026-11-04T12:40:00Z')],
      ['account2@example.com', 1, at('2026-11-04T12:20:00Z')],
      ['account2@example.com', 1, at('2026-11-04T12:10:00Z')],
    ]);
  });

  test('a line takes its recovery time from the newest error in it', () => {
    const errors = [error(2, '2026-11-04T12:30:00Z', ACC3, { recoverAt: at('2026-11-04T18:00:00Z') }), error(1, '2026-11-04T12:00:00Z', ACC3, { recoverAt: at('2026-11-04T17:00:00Z') })];
    expect(view([], { range: '7d' }, { errors }).errorLog.groups[0]!.recoverAt).toBe(at('2026-11-04T18:00:00Z'));
  });

  describe('coverage: how many of the failures CPA logged', () => {
    const failing = (outcomes: Partial<Record<Outcome, number>>) => [cell('2026-11-04T12:00:00Z', ACC1, tally({ outcomes: { ok: 40, ...outcomes } }))];
    const log = (cells: readonly UsageCell[], errors: readonly ErrorEvent[]) => view(cells, { range: '7d' }, { errors }).errorLog;

    test('counts the faults, and leaves out cancelled requests, which are not faults', () => {
      const errors = [error(2, '2026-11-04T12:30:00Z', ACC1), error(1, '2026-11-04T12:20:00Z', ACC1)];
      expect(log(failing({ rate_limited: 3, server_error: 5, client_closed: 12 }), errors)).toMatchObject({ faults: 8, covered: 2 });
    });

    test('a cancelled request in the log is not a covered fault', () => {
      const errors = [error(2, '2026-11-04T12:30:00Z', ACC1, { status: 499, outcome: 'client_closed' }), error(1, '2026-11-04T12:20:00Z', ACC1)];
      expect(log(failing({ rate_limited: 3 }), errors)).toMatchObject({ faults: 3, covered: 1 });
    });

    test('never covers more than failed, even when the log holds more', () => {
      const errors = [3, 2, 1].map((id) => error(id, `2026-11-04T12:${10 + id}:00Z`, ACC1));
      expect(log(failing({ rate_limited: 2 }), errors)).toMatchObject({ faults: 2, covered: 2 });
    });

    test('with nothing failed and nothing logged, both are zero', () => {
      expect(log(failing({}), [])).toMatchObject({ faults: 0, covered: 0, groups: [] });
    });
  });
});

describe('pace joins the quota window with what it has cost', () => {
  const DAY = 24 * HOUR;
  const window = (kind: string, used: number, resetsInMs: number, scopeModel: string | null = null): Limit => ({ kind, percent: used as Percent, severity: 'normal', resetsAt: (NOW + resetsInMs) as Instant, scopeModel, isActive: true });
  const session = (used: number, resetsInMs: number): Limit => window('session', used, resetsInMs);
  const withDeck = (limits: Readonly<Record<AccountId, readonly Limit[]>>): AccountView[] =>
    accounts.map((a) => ({ ...a, limits: a.id in limits ? mergeLimits({ value: limits[a.id]!, at: NOW }, null, NOW) : [] }));
  const withLimits = (id: AccountId, limits: readonly Limit[]): AccountView[] => withDeck({ [id]: limits } as Record<AccountId, readonly Limit[]>);
  const outlooks = (windows: readonly { readonly limit: { readonly key: string }; readonly pace: { readonly outlook: { readonly kind: string } } }[]) => windows.map((w) => [w.limit.key, w.pace.outlook.kind]);
  const cells = [
    cell('2026-11-04T10:00:00Z', ACC1, ok(100)),
    cell('2026-11-04T11:00:00Z', ACC1, tally({ outcomes: { ok: 6 }, output: 900 })),
    cell('2026-11-04T12:00:00Z', ACC1, tally({ outcomes: { ok: 4 }, output: 300 }), 'claude-sonnet-5-5'),
    cell('2026-11-04T12:00:00Z', ACC3, ok(50)),
  ];

  test('spent counts every model on the account from the hour the window opened; perPercent divides by what is used', () => {
    const v = view(cells, { range: '24h', model: 'claude-opus-5-5' }, {}, withLimits(ACC1, [session(40, 3 * HOUR)]));
    expect(v.pace).toHaveLength(1);
    const p = v.pace[0]!.steady[0]!;
    expect(p).toMatchObject({ account: ACC1, email: 'account1@example.com', limit: { key: 'session', label: 'Session' } });
    expect(p.pace.startsAt).toBe(at('2026-11-04T11:00:00Z'));
    expect(p.spent.requests).toBe(10);
    expect(p.perPercent).toEqual({ requests: 10 / 40, output: 1_200 / 40, freshInput: 0 });
  });

  test('under 1% used there is no cost per percent, and an account lens keeps only its own windows', () => {
    expect(view(cells, { range: '24h' }, {}, withLimits(ACC1, [session(0.5, 3 * HOUR)])).pace[0]!.steady[0]!.perPercent).toBeNull();
    expect(view(cells, { range: '24h', account: ACC3 }, {}, withLimits(ACC1, [session(40, 3 * HOUR)])).pace).toEqual([]);
  });

  test('a window that runs out or is at its limit keeps a bar, one that lasts folds, and both keep the order the card lists them in', () => {
    const deck = withDeck({ [ACC1]: [window('weekly_scoped', 90, 6 * DAY, 'Fable'), window('weekly_all', 10, 6 * DAY), session(100, 3 * HOUR)] } as Record<AccountId, readonly Limit[]>);
    const [one] = view(cells, { range: '24h' }, {}, deck).pace;
    expect(outlooks(one!.attention)).toEqual([
      ['session', 'at_limit'],
      ['weekly_scoped:Fable', 'hits'],
    ]);
    expect(outlooks(one!.steady)).toEqual([['weekly_all', 'lasts']]);
  });

  test('a window too early to project folds with the ones that last, and an account with no open window is left out', () => {
    const deck = withDeck({ [ACC1]: [window('weekly_all', 10, 6 * DAY)], [ACC2]: [window('weekly_all', 1, 6.95 * DAY)] } as Record<AccountId, readonly Limit[]>);
    const v = view(cells, { range: '24h' }, {}, deck);
    expect(v.pace.map((a) => a.account)).toEqual([ACC1, ACC2]);
    expect(v.pace[1]!.attention).toEqual([]);
    expect(outlooks(v.pace[1]!.steady)).toEqual([['weekly_all', 'too_early']]);
  });
});

test('catchingUp and the keeper timestamp pass through', () => {
  const v = view([], { range: '24h' }, { catchingUp: true, keeperLatestAt: at('2026-11-04T12:59:00Z') });
  expect(v.catchingUp).toBe(true);
  expect(v.keeperLatestAt).toBe(at('2026-11-04T12:59:00Z'));
  expect(v.asOf).toBe(NOW);
});
