import { describe, expect, test } from 'bun:test';
import { createLedger, outcomeOf, type UsageEvent } from '../src/server/ledger';
import type { AccountId } from '../src/shared/domain';
import { latencyBin } from '../src/shared/usage';
import { ACC1, ACC2, ACC3, at } from './support';

const ALL = new Set([ACC1, ACC2, ACC3]);
let nextId = 1;
const event = (iso: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: nextId++,
  at: at(iso),
  account: ACC1,
  model: 'claude-opus-5-5',
  effort: 'high',
  outcome: 'ok',
  latencyMs: 5_000,
  ttftMs: 1_000,
  tokens: { freshInput: 2, cacheRead: 100, cacheCreation: 10, output: 50, reasoning: 20 },
  session: 's1',
  ...over,
});
const through = (events: readonly UsageEvent[]) => Math.max(...events.map((e) => e.id));
const summary = (cells: ReturnType<ReturnType<typeof createLedger>['slice']>) =>
  cells.map((c) => [new Date(c.hour).toISOString().slice(0, 13), c.account, c.model, c.effort, c.tally.outcomes, c.tally.sessionsStarted]);

describe('outcomeOf', () => {
  test.each([
    [0, 200, 'ok'],
    [1, 429, 'rate_limited'],
    [1, 499, 'client_closed'],
    [1, 500, 'server_error'],
    [1, 529, 'server_error'],
    [1, 401, 'other_error'],
    [1, null, 'other_error'],
    [null, 404, 'other_error'],
    [null, null, 'ok'],
  ] as const)('failed %p, status %p is %s', (failed, status, outcome) => {
    expect(outcomeOf(failed, status)).toBe(outcome);
  });
});

describe('a ledger folds events into hourly cells', () => {
  test('per UTC hour, account, model and effort, with token sums, outcome counts and ok-only latency', () => {
    const events = [
      event('2026-11-04T12:10:00Z'),
      event('2026-11-04T12:50:00Z', { latencyMs: 20_000, ttftMs: null }),
      event('2026-11-04T12:59:59Z', { outcome: 'rate_limited', latencyMs: 400, tokens: { freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0 } }),
      event('2026-11-04T13:00:00Z', { effort: 'max' }),
      event('2026-11-04T13:05:00Z', { account: ACC2, session: 's2' }),
    ];
    const l = createLedger(0);
    l.advance(events, through(events));
    const cells = l.slice(ALL);
    expect(cells.map((c) => [new Date(c.hour).toISOString(), c.account, c.effort])).toEqual([
      ['2026-11-04T12:00:00.000Z', ACC1, 'high'],
      ['2026-11-04T13:00:00.000Z', ACC2, 'high'],
      ['2026-11-04T13:00:00.000Z', ACC1, 'max'],
    ]);
    const noon = cells[0]!.tally;
    expect(noon.outcomes).toEqual({ ok: 2, rate_limited: 1, client_closed: 0, server_error: 0, other_error: 0 });
    expect(noon.tokens).toEqual({ freshInput: 4, cacheRead: 200, cacheCreation: 20, output: 100, reasoning: 40 });
    expect(noon.latencyMs).toEqual([
      [latencyBin(5_000), 1],
      [latencyBin(20_000), 1],
    ]);
    expect(noon.ttftMs).toEqual([[latencyBin(1_000), 1]]);
    expect(cells.map((c) => c.tally.sessionsStarted)).toEqual([1, 1, 0]);
    expect(l.cursor).toBe(through(events));
    expect(l.latestAt).toBe(at('2026-11-04T13:05:00Z'));
  });

  test('reading in slices, or reading a slice twice, gives the same cells as one read', () => {
    const events = Array.from({ length: 30 }, (_, i) => event(`2026-11-04T${String(10 + (i % 5)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00Z`, { session: `s${i % 4}`, account: [ACC1, ACC2, ACC3][i % 3]! }));
    const once = createLedger(events[0]!.id - 1);
    once.advance(events, through(events));
    const sliced = createLedger(events[0]!.id - 1);
    for (let i = 0; i < events.length; i += 7) {
      const slice = events.slice(i, i + 7);
      sliced.advance(slice, through(slice));
      sliced.advance(slice, through(slice));
    }
    sliced.advance(events, through(events));
    expect(sliced.slice(ALL)).toEqual(once.slice(ALL));
    expect(sliced.slice(ALL).reduce((n, c) => n + c.tally.outcomes.ok, 0)).toBe(30);
  });

  test('ids at or below the starting cursor are never folded', () => {
    const events = [event('2026-11-04T10:00:00Z'), event('2026-11-04T11:00:00Z')];
    const l = createLedger(events[0]!.id);
    l.advance(events, through(events));
    expect(summary(l.slice(ALL)).map((c) => c[0])).toEqual(['2026-11-04T11']);
  });

  test('a late row with an old timestamp lands in its own hour and moves its session start there', () => {
    const l = createLedger(0);
    const first = [event('2026-11-04T12:00:00Z', { session: 'late' }), event('2026-11-04T12:30:00Z', { session: 'late' })];
    l.advance(first, through(first));
    const late = [event('2026-11-04T09:15:00Z', { session: 'late' })];
    l.advance(late, through(late));
    expect(summary(l.slice(ALL)).map((c) => [c[0], c[5]])).toEqual([
      ['2026-11-04T09', 1],
      ['2026-11-04T12', 0],
    ]);
  });

  test('evict drops older hours, is idempotent, and leaves the cells a fresh read of the horizon would give', () => {
    const before = [event('2026-11-01T08:00:00Z', { session: 'spans' }), event('2026-11-01T09:00:00Z', { session: 'gone' })];
    const after = [
      event('2026-11-02T10:00:00Z', { session: 'spans' }),
      event('2026-11-02T11:00:00Z', { session: 'new' }),
      event('2026-11-03T12:00:00Z', { session: 'spans' }),
    ];
    const running = createLedger(0);
    running.advance(before, through(before));
    running.advance(after, through(after));
    running.evict(at('2026-11-02T00:00:00Z'));
    running.evict(at('2026-11-02T00:00:00Z'));
    const fresh = createLedger(0);
    fresh.advance(after, through(after));
    expect(running.slice(ALL)).toEqual(fresh.slice(ALL));
    expect(summary(running.slice(ALL)).map((c) => [c[0], c[5]])).toEqual([
      ['2026-11-02T10', 1],
      ['2026-11-02T11', 1],
      ['2026-11-03T12', 0],
    ]);
  });

  test('slice keeps only the accounts asked for and copies the cells out', () => {
    const l = createLedger(0);
    const events = [event('2026-11-04T10:00:00Z', { account: ACC1 }), event('2026-11-04T10:00:00Z', { account: 'ffffffffffffffff' as AccountId })];
    l.advance(events, through(events));
    const cells = l.slice(new Set([ACC1]));
    expect(cells.map((c) => c.account)).toEqual([ACC1]);
    (cells[0]!.tally.outcomes as { ok: number }).ok = 99;
    expect(l.slice(new Set([ACC1]))[0]!.tally.outcomes.ok).toBe(1);
  });

  test('an empty slice still moves the cursor, so rows keeper.ts could not parse are not read again', () => {
    const l = createLedger(10);
    l.advance([], 25);
    expect(l.cursor).toBe(25);
    l.advance([event('2026-11-04T10:00:00Z', { id: 20 })], 25);
    expect(l.slice(ALL)).toEqual([]);
    expect(l.latestAt).toBeNull();
  });
});
