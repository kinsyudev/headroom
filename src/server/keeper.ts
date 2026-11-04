/**
 * Keeper history, read-only. Keeper owns ingestion: it subscribes to CPA's usage stream and writes
 * app.db. The deck opens that file read-only and runs SELECTs, nothing else.
 *
 * - Opened with `{ readonly: true }` (SQLITE_OPEN_READONLY) plus `PRAGMA query_only = ON`.
 *   test/boundaries.test.ts checks that every SQL string in this file starts with SELECT or PRAGMA query_only.
 * - Timestamps are text with keeper's +08:00 offset, not the Mac's. Every time comparison goes
 *   through strftime('%s', timestamp), which normalizes the offset to Unix seconds. Never compare
 *   the text directly.
 * - SQL groups by UTC hour only. Folding hours into local days happens in TS with the Mac's real
 *   time zone rules (`foldSeries`), so DST days come out right.
 * - Results are memoized for 30 s per range. bun:sqlite is synchronous, and a 30-day scan blocks
 *   the event loop for ~0.1-0.3 s, so the memo caps that at one scan per range per 30 s.
 */
import { Database } from 'bun:sqlite';
import type { AccountId, Instant } from '../shared/domain';
import type { HistoryRange, HistoryView, TokenTotals } from '../shared/history';

export interface Keeper {
  /** Throws if the DB can't be opened (keeper not installed, or WAL -shm missing while keeper is down). http.ts maps that to 503. */
  history(range: HistoryRange, now: Instant): HistoryView;
}

export function openKeeper(path: string, opts: { readonly timeZone: string }): Keeper {
  // TODO: lazy open on first call: new Database(`file:${path}?mode=ro`, { readonly: true }); exec('PRAGMA query_only = ON');
  //       on SQLITE_CANTOPEN retry next call (keeper may be starting). Memo Map<range, {at, view}>.
  void Database;
  throw new Error('not implemented');
}

/** Shared fragment. Fresh input clamps per row so a provider whose input excludes cache can't go negative. */
const TOTALS = /* sql */ `
  COUNT(*)                                                                          AS requests,
  SUM(CASE WHEN failed THEN 1 ELSE 0 END)                                           AS failed,
  SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END)                                AS rate_limited,
  SUM(MAX(COALESCE(input_tokens, 0) - cache_read_tokens - cache_creation_tokens, 0)) AS fresh_input,
  SUM(cache_read_tokens)                                                            AS cache_read,
  SUM(cache_creation_tokens)                                                        AS cache_creation,
  SUM(COALESCE(output_tokens, 0))                                                   AS output,
  SUM(COALESCE(reasoning_tokens, 0))                                                AS reasoning`;

export const SQL = {
  /** One row per (account, UTC hour since epoch). Used for every range; foldSeries makes days. */
  hourly: /* sql */ `
    SELECT auth_index                                              AS account,
           CAST(strftime('%s', timestamp) AS INTEGER) / 3600       AS hour,
           ${TOTALS}
    FROM usage_events
    WHERE CAST(strftime('%s', timestamp) AS INTEGER) >= $since
    GROUP BY account, hour`,

  /** Per account × model over the range. */
  models: /* sql */ `
    SELECT auth_index AS account, model,
           ${TOTALS},
           AVG(latency_ms) AS avg_latency_ms,
           AVG(ttft_ms)    AS avg_ttft_ms
    FROM usage_events
    WHERE CAST(strftime('%s', timestamp) AS INTEGER) >= $since
    GROUP BY account, model
    ORDER BY requests DESC`,

  /** Newest 50 errors (429s included). It walks the PK backwards, so it's cheap. */
  errors: /* sql */ `
    SELECT id, timestamp, auth_index AS account, model, status_code, code,
           auth_quota_reason, auth_quota_next_recover_at, substr(body, 1, 600) AS body
    FROM error_events
    ORDER BY id DESC
    LIMIT 50`,

  /** Keeper's own freshness. */
  latest: /* sql */ `SELECT timestamp FROM usage_events ORDER BY id DESC LIMIT 1`,
} as const;

export interface HourRow extends TokenTotalsRow {
  readonly account: AccountId;
  readonly hour: number;
}
interface TokenTotalsRow {
  readonly requests: number;
  readonly failed: number;
  readonly rate_limited: number;
  readonly fresh_input: number;
  readonly cache_read: number;
  readonly cache_creation: number;
  readonly output: number;
  readonly reasoning: number;
}

/**
 * Turn hourly rows into a contiguous, zero-filled series of local hours or local days.
 * Pure; exported for tests (a DST-crossing 7 d range is the interesting case).
 *
 * TODO:
 * since = range start aligned to a local hour (24h) or local midnight (7d/30d), via Intl in `timeZone`
 * build the bucket grid from since to now (day buckets: step to the next local midnight, not +24 h)
 * for each row: t = row.hour * 3_600_000; bucket = last grid start <= t; add totals into byAccount[row.account]
 */
export function foldSeries(rows: readonly HourRow[], range: HistoryRange, now: Instant, timeZone: string): HistoryView['series'] {
  throw new Error('not implemented');
}

export function rangeStart(range: HistoryRange, now: Instant, timeZone: string): Instant {
  throw new Error('not implemented');
}

export function toTotals(r: TokenTotalsRow): TokenTotals {
  throw new Error('not implemented');
}
