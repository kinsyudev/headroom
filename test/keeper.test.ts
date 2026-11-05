process.env.TZ = 'Europe/Madrid';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKeeper } from '../src/server/keeper';
import { foldHistory, type HourRow } from '../src/shared/history';
import type { AccountId, Instant } from '../src/shared/domain';
import { insertUsage, keeperTime } from './fake-keeper';
import { ACC1, ACC2, ACC3, FIXTURES, at } from './support';

const NOW = at('2026-11-04T13:00:00Z');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function db(): { path: string; handle: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'headroom-keeper-'));
  dirs.push(dir);
  const path = join(dir, 'app.db');
  const handle = new Database(path, { create: true });
  handle.exec(readFileSync(join(FIXTURES, 'keeper-schema.sql'), 'utf8'));
  insertUsage(handle, { at: at('2026-11-04T12:10:00Z'), account: ACC1, model: 'claude-opus-5-5', input: 50_000, cacheRead: 40_000, cacheCreation: 5_000, output: 900 });
  insertUsage(handle, { at: at('2026-11-04T12:58:30Z'), account: ACC1, model: 'claude-opus-5-5', input: 1_000, output: 100 });
  insertUsage(handle, { at: at('2026-11-04T12:59:30Z'), account: ACC3, model: 'claude-opus-5-5', failed: true, status: 429 });
  insertUsage(handle, { at: at('2026-11-04T11:30:00Z'), account: ACC3, model: 'claude-sonnet-5-5', input: 2_000, output: 50 });
  insertUsage(handle, { at: at('2026-11-03T23:59:00Z'), account: ACC2, model: 'claude-opus-5-5', input: 10, output: 5 });
  insertUsage(handle, { at: at('2026-11-02T10:00:00Z'), account: ACC2, model: 'claude-opus-5-5', input: 7, output: 7 });
  insertUsage(handle, { at: at('2026-11-04T12:30:00Z'), account: 'ffffffffffffffff', model: 'gpt-5', input: 999, output: 999 });
  handle
    .query(`INSERT INTO error_events (timestamp, auth_index, model, status_code, body, auth_quota_reason, auth_quota_next_recover_at) VALUES (?, ?, 'm', 429, ?, ?, ?)`)
    .run(keeperTime(at('2026-11-04T12:59:30Z')), ACC3, '{"type":"error","error":{"type":"rate_limit_error","message":"monthly spend limit"}}', 'credential_quota', keeperTime(at('2026-11-04T14:20:17Z')));
  handle
    .query(`INSERT INTO error_events (timestamp, auth_index, model, status_code, body) VALUES (?, 'ffffffffffffffff', 'm', 500, 'x')`)
    .run(keeperTime(NOW));
  return { path, handle };
}

describe('serving evidence', () => {
  test('last success per account from +08:00 timestamps; 429s are not evidence', () => {
    const { path } = db();
    const k = openKeeper(path, () => NOW);
    k.start();
    k.stop();
    const seen = Object.fromEntries((k.serving().last?.value ?? []).map((s) => [s.account, s]));
    expect(seen[ACC1]).toEqual({ account: ACC1, lastAt: at('2026-11-04T12:58:30Z'), recent: 1 });
    expect(seen[ACC3]).toEqual({ account: ACC3, lastAt: at('2026-11-04T11:30:00Z'), recent: 0 });
    expect(k.serving().error).toBeNull();
  });

  test('a missing DB is an error on the source, not a crash', () => {
    const k = openKeeper('/nonexistent/app.db', () => NOW);
    k.start();
    k.stop();
    expect(k.serving().error?.value.kind).toBe('unavailable');
    expect(() => k.history('24h', [ACC1])).toThrow(/keeper database unreadable/);
  });
});

describe('history', () => {
  const ids = [ACC1, ACC2, ACC3];

  test('24h: sparse UTC-hour rows per account and model, fresh input excludes cache, unknown accounts dropped', () => {
    const { path } = db();
    const h = openKeeper(path, () => NOW).history('24h', ids);
    const rows = h.hours.map((r) => [new Date(r.hour).toISOString(), r.account, r.model, r.totals.requests, r.totals.freshInput, r.totals.cacheRead, r.totals.failed, r.totals.rateLimited]);
    expect(rows.sort()).toEqual(
      [
        ['2026-11-03T23:00:00.000Z', ACC2, 'claude-opus-5-5', 1, 10, 0, 0, 0],
        ['2026-11-04T11:00:00.000Z', ACC3, 'claude-sonnet-5-5', 1, 2_000, 0, 0, 0],
        ['2026-11-04T12:00:00.000Z', ACC1, 'claude-opus-5-5', 2, 5_000 + 1_000, 40_000, 0, 0],
        ['2026-11-04T12:00:00.000Z', ACC3, 'claude-opus-5-5', 1, 0, 0, 1, 1],
      ].sort(),
    );
    expect(h.models.find((m) => m.account === ACC1)).toMatchObject({ model: 'claude-opus-5-5', totals: { requests: 2, output: 1_000 }, avgLatencyMs: 1200 });
    expect(h.errors).toEqual([
      { id: 1, at: at('2026-11-04T12:59:30Z'), account: ACC3, model: 'm', status: 429, quotaReason: 'credential_quota', recoverAt: at('2026-11-04T14:20:17Z'), message: 'monthly spend limit' },
    ]);
    expect(h.keeperLatestAt).toBe(at('2026-11-04T12:30:00Z'));
  });

  test('7d reaches back past the 24h window', () => {
    const { path } = db();
    expect(openKeeper(path, () => NOW).history('7d', ids).hours.some((r) => r.hour === at('2026-11-02T10:00:00Z'))).toBe(true);
  });

  test('results are memoized for 30 s per range', () => {
    const { path, handle } = db();
    let now = NOW;
    const k = openKeeper(path, () => now);
    const first = k.history('24h', ids);
    insertUsage(handle, { at: NOW, account: ACC1, model: 'claude-opus-5-5', input: 1, output: 1 });
    now = (NOW + 29_000) as Instant;
    expect(k.history('24h', ids)).toBe(first);
    now = (NOW + 31_000) as Instant;
    expect(k.history('24h', ids).hours.length).toBeGreaterThan(first.hours.length);
  });
});

describe('foldHistory in the browser time zone', () => {
  const row = (iso: string, account: AccountId, requests = 1): HourRow => ({
    hour: at(iso),
    account,
    model: 'm',
    totals: { requests, failed: 0, rateLimited: 0, freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0 },
  });

  test('30d day buckets step by local date, so the DST day is 25 hours', () => {
    const { bucket, buckets } = foldHistory(
      [row('2026-10-24T22:30:00Z', ACC1), row('2026-10-25T22:59:00Z', ACC1, 2), row('2026-10-25T23:00:00Z', ACC1, 4)],
      '30d',
      NOW,
    );
    expect(bucket).toBe('day');
    expect(buckets).toHaveLength(30);
    const lengths = buckets.map((b) => (b.end - b.start) / 3_600_000);
    expect(lengths.filter((h) => h === 25)).toHaveLength(1);
    expect(lengths.filter((h) => h === 24)).toHaveLength(29);
    const dst = buckets.find((b) => b.end - b.start === 25 * 3_600_000)!;
    expect(new Date(dst.start).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(dst.byAccount.get(ACC1)?.requests).toBe(3);
    expect(buckets[buckets.indexOf(dst) + 1]!.byAccount.get(ACC1)?.requests).toBe(4);
    expect(buckets.at(-1)!.end).toBeGreaterThan(NOW);
  });

  test('24h: 24 contiguous hours ending in the current one; older rows are dropped', () => {
    const { bucket, buckets } = foldHistory([row('2026-11-04T12:00:00Z', ACC1, 5), row('2026-11-03T12:00:00Z', ACC2)], '24h', NOW);
    expect(bucket).toBe('hour');
    expect(buckets).toHaveLength(24);
    expect(buckets.at(-1)!.start).toBe(NOW);
    expect(buckets.at(-2)!.byAccount.get(ACC1)?.requests).toBe(5);
    expect(buckets.flatMap((b) => [...b.byAccount.keys()])).not.toContain(ACC2);
  });

  test.each(['24h', '7d', '30d'] as const)('%s: only the bucket still running at now is partial', (range) => {
    const flags = (now: number) => foldHistory([], range, now as Instant).buckets.map((b) => b.partial);
    for (const now of [NOW, NOW + 1, NOW + 59 * 60_000]) {
      const marked = flags(now);
      expect(marked.at(-1)).toBe(true);
      expect(marked.slice(0, -1).some(Boolean)).toBe(false);
    }
  });

  test('a bucket that ends exactly at now is complete and the next one is partial', () => {
    const { buckets } = foldHistory([], '24h', NOW);
    expect(buckets.at(-2)!.end).toBe(NOW);
    expect(buckets.at(-2)!.partial).toBe(false);
    expect(buckets.at(-1)!.partial).toBe(true);
  });
});
