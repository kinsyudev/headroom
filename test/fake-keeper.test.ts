import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKeeperDb,
  FAKE_HISTORY_MS,
  FAKE_TARGETS,
  FEED_TICK_MS,
  fakeTimeline,
  feedKeeper,
  KEEPER_ACC1,
  KEEPER_ACC3,
  keeperTime,
  profile,
} from './fake-keeper';

const DAY = 86_400_000;
/** Monday 05:00 at the fake's default +01:00, where a day block starts. */
const MONDAY = Date.parse('2026-10-05T04:00:00Z');
const WEEKS = 4 * 7 * DAY;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'headroom-fake-'));
  dirs.push(dir);
  return join(dir, 'app.db');
};

describe('the timeline is a pure function of time', () => {
  test('usage(a, c) is usage(a, b) followed by usage(b, c), for cuts inside and across day blocks', () => {
    const t = fakeTimeline();
    const a = MONDAY - 3 * DAY + 12_345;
    const c = MONDAY + 2 * DAY;
    for (const b of [a, MONDAY - 1, MONDAY, MONDAY + 1, MONDAY + 13 * 3_600_000 + 777, c]) {
      expect([...t.usage(a, b), ...t.usage(b, c)]).toEqual([...t.usage(a, c)]);
      expect([...t.errors(a, b), ...t.errors(b, c)]).toEqual([...t.errors(a, c)]);
    }
  });

  test('a fresh timeline asked in another order returns the same rows', () => {
    const from = MONDAY + 3 * DAY;
    const first = fakeTimeline().usage(from, from + DAY);
    const other = fakeTimeline();
    other.usage(from + 5 * DAY, from + 6 * DAY);
    expect(other.usage(from, from + DAY)).toEqual(first);
    expect(first.length).toBeGreaterThan(1_000);
  });

  test('rows come in time order and a different seed gives a different history', () => {
    const rows = fakeTimeline().usage(MONDAY, MONDAY + 2 * DAY);
    expect(rows.every((r, i) => i === 0 || rows[i - 1]!.at <= r.at)).toBe(true);
    expect(fakeTimeline({ seed: 1 }).usage(MONDAY, MONDAY + DAY)).not.toEqual(rows.filter((r) => r.at < MONDAY + DAY));
  });
});

describe.each([
  ['four weeks from a Monday', MONDAY],
  ['four weeks from a Wednesday afternoon', MONDAY + 9.3 * DAY],
])('the shape over %s matches the live DB', (_label, from) => {
  const span = { from, to: from + WEEKS };
  const rows = fakeTimeline().usage(span.from, span.to);
  const p = profile(rows, span);
  const within = (x: number, band: { readonly min: number; readonly max: number }) => expect({ x, ...band, ok: x >= band.min && x <= band.max }).toMatchObject({ ok: true });

  test('volume: requests and sessions per day', () => {
    within(p.requestsPerDay, FAKE_TARGETS.requestsPerDay);
    within(p.sessionsPerDay, FAKE_TARGETS.sessionsPerDay);
  });

  test('model mix and cache: opus share and cache-read share of input', () => {
    within(p.modelShare['claude-opus-5-5']!, FAKE_TARGETS.opusShare);
    within(p.cacheReadShare, FAKE_TARGETS.cacheReadShare);
  });

  test('time of use: Monday above Saturday, 15:00 above 07:00 local', () => {
    expect(p.weekdayPerDay[0]!).toBeGreaterThan(1.4 * p.weekdayPerDay[5]!);
    expect(p.hourShare[15]!).toBeGreaterThan(3 * p.hourShare[7]!);
  });

  test('latency and time to first token of ok opus requests', () => {
    within(p.opusLatencyMs.p50, FAKE_TARGETS.opusLatencyMs.p50);
    within(p.opusLatencyMs.p90, FAKE_TARGETS.opusLatencyMs.p90);
    within(p.opusTtftMs.p50, FAKE_TARGETS.opusTtftMs.p50);
    within(p.opusTtftMs.p90, FAKE_TARGETS.opusTtftMs.p90);
  });

  test('failures: 499 and 5xx rates, and 429s only on account3', () => {
    within(p.statusShare['499'] ?? 0, FAKE_TARGETS.clientClosedShare);
    const serverErrors = Object.entries(p.statusShare).reduce((s, [code, share]) => (Number(code) >= 500 ? s + share : s), 0);
    within(serverErrors, FAKE_TARGETS.serverErrorShare);
    const limited = rows.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(new Set(limited.map((r) => r.account))).toEqual(new Set([KEEPER_ACC3]));
  });

  test('every 429 and 5xx row has an error event at its response instant on the same account and model', () => {
    const errors = fakeTimeline().errors(span.from, span.to + 2 * 60_000);
    const key = (at: number, r: { account: string; model: string; status?: number }) => `${at}|${r.account}|${r.model}|${r.status}`;
    const events = new Set(errors.map((e) => key(e.at, e)));
    const failures = rows.filter((r) => r.status === 429 || (r.status ?? 200) >= 500);
    expect(failures.length).toBeGreaterThan(5);
    expect(failures.filter((r) => !events.has(key(r.at + r.latencyMs!, r)))).toEqual([]);
    expect(errors.filter((e) => e.status === 429).every((e) => e.quotaReason === 'credential_quota' && e.recoverAt! > e.at)).toBe(true);
  });

  test('account1 never goes 100 s without a successful request, so it reads as serving at any hour', () => {
    const ok = rows.filter((r) => r.account === KEEPER_ACC1 && (r.status ?? 200) < 400).map((r) => r.at);
    const gaps = ok.slice(1).map((t, i) => t - ok[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(100_000);
    expect(ok[0]! - span.from).toBeLessThanOrEqual(100_000);
  });
});

describe('the fake keeper DB', () => {
  const read = (path: string) => {
    const db = new Database(path, { readonly: true });
    const usage = db.query<{ timestamp: string; failed: number; status_code: number }, []>('SELECT timestamp, failed, status_code FROM usage_events ORDER BY id').all();
    const errors = db.query<{ timestamp: string }, []>('SELECT timestamp FROM error_events ORDER BY id').all();
    db.close();
    return { usage, errors };
  };
  const small = { requestsPerDay: 300 };

  test('createKeeperDb holds exactly the timeline rows before the 10 s boundary at or below now', () => {
    const path = tempDb();
    const now = MONDAY + 3 * DAY + 4_321;
    const to = createKeeperDb(path, now, small);
    expect(to).toBe(Math.floor(now / FEED_TICK_MS) * FEED_TICK_MS);
    const want = fakeTimeline(small).usage(to - FAKE_HISTORY_MS, to);
    const { usage } = read(path);
    expect(usage.map((r) => r.timestamp)).toEqual(want.map((r) => keeperTime(r.at)));
    expect(usage.every((r) => r.failed === (r.status_code >= 400 ? 1 : 0))).toBe(true);
  });

  test('feedKeeper continues where createKeeperDb stopped: a fed DB equals one created later', () => {
    const fed = tempDb();
    const later = tempDb();
    const t0 = MONDAY + 5 * DAY + 2_000;
    const t1 = t0 + 47_000;
    const feed = feedKeeper(fed, { ...small, from: createKeeperDb(fed, t0, small), clock: () => t1 });
    feed.stop();
    createKeeperDb(later, t1, small);
    const a = read(fed);
    const b = read(later);
    const overlap = keeperTime(Math.floor(t1 / FEED_TICK_MS) * FEED_TICK_MS - FAKE_HISTORY_MS);
    const fromFed = (rows: { timestamp: string }[]) => rows.map((r) => r.timestamp).filter((s) => s >= overlap);
    expect(fromFed(a.usage)).toEqual(fromFed(b.usage));
    expect(fromFed(a.errors)).toEqual(fromFed(b.errors));
    expect(a.usage.at(-1)).toEqual(b.usage.at(-1));
  });

});
