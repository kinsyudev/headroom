/**
 * keeper's SQLite, read-only. keeper owns ingestion; the deck opens the file with `mode=ro`,
 * sets `query_only`, and runs SELECTs only. This is the only file that names `input_tokens`.
 *
 * - Serving evidence: every 5 s, the newest 500 usage_events grouped by account, giving the last
 *   successful request and how many succeeded in the last 2 minutes.
 * - History: sparse rows per UTC hour, account and model (the browser folds them into local hours
 *   or days), per-model totals over the range, and the newest 50 errors. Memoized 30 s per range,
 *   because a 30-day scan blocks the event loop for about 0.3 s.
 * - Timestamps carry keeper's +08:00 offset. Every comparison goes through julianday(), which
 *   normalizes the offset; the text is never compared directly.
 */
import { Database } from 'bun:sqlite';
import { DeckError } from '../shared/actions';
import { emptySource, parseInstant, type AccountId, type Instant, type ServingSeen, type Source } from '../shared/domain';
import { SERVING_WINDOW_MS } from '../shared/derive';
import { RANGE_MS, type ErrorRow, type HistoryRange, type HistoryView, type TokenTotals } from '../shared/history';

export const SERVING_EVERY_MS = 5_000;
export const HISTORY_MEMO_MS = 30_000;

export interface Keeper {
  start(): void;
  stop(): void;
  serving(): Source<readonly ServingSeen[]>;
  /** Throws DeckError('unavailable') when the DB can't be read. */
  history(range: HistoryRange, accounts: readonly AccountId[]): HistoryView;
}

const TOTALS = /* sql */ `
  COUNT(*)                                                                    AS requests,
  SUM(CASE WHEN COALESCE(failed, 0) != 0 THEN 1 ELSE 0 END)                   AS failed,
  SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END)                          AS rate_limited,
  SUM(MAX(COALESCE(input_tokens, 0) - cache_read_tokens - cache_creation_tokens, 0)) AS fresh_input,
  SUM(cache_read_tokens)                                                      AS cache_read,
  SUM(cache_creation_tokens)                                                  AS cache_creation,
  SUM(COALESCE(output_tokens, 0))                                             AS output`;

const KNOWN = /* sql */ `auth_index IN (SELECT value FROM json_each($ids))`;

export const SQL = {
  serving: /* sql */ `
    SELECT auth_index AS account,
           MAX(CASE WHEN COALESCE(failed, 0) = 0 THEN julianday(timestamp) END)                         AS last_jd,
           SUM(CASE WHEN COALESCE(failed, 0) = 0 AND julianday(timestamp) >= $since THEN 1 ELSE 0 END) AS recent
    FROM (SELECT auth_index, timestamp, failed FROM usage_events ORDER BY id DESC LIMIT 500)
    GROUP BY auth_index`,
  hours: /* sql */ `
    SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour, auth_index AS account, model, ${TOTALS}
    FROM usage_events
    WHERE julianday(timestamp) >= $since AND ${KNOWN}
    GROUP BY hour, account, model`,
  models: /* sql */ `
    SELECT auth_index AS account, model, ${TOTALS}, AVG(latency_ms) AS avg_latency_ms, AVG(ttft_ms) AS avg_ttft_ms
    FROM usage_events
    WHERE julianday(timestamp) >= $since AND ${KNOWN}
    GROUP BY account, model
    ORDER BY requests DESC`,
  errors: /* sql */ `
    SELECT id, timestamp, auth_index AS account, model, status_code, auth_quota_reason, auth_quota_next_recover_at,
           substr(body, 1, 600) AS body
    FROM error_events
    WHERE ${KNOWN}
    ORDER BY id DESC
    LIMIT 50`,
  latest: /* sql */ `SELECT timestamp FROM usage_events ORDER BY id DESC LIMIT 1`,
} as const;

interface TotalsRow {
  readonly requests: number;
  readonly failed: number | null;
  readonly rate_limited: number | null;
  readonly fresh_input: number | null;
  readonly cache_read: number | null;
  readonly cache_creation: number | null;
  readonly output: number | null;
}

const toJulian = (ms: number) => ms / 86_400_000 + 2_440_587.5;
const fromJulian = (jd: number) => Math.round((jd - 2_440_587.5) * 86_400_000) as Instant;

export function openKeeper(path: string, now: () => Instant): Keeper {
  let db: Database | null = null;
  let servingSrc: Source<readonly ServingSeen[]> = emptySource();
  let timer: ReturnType<typeof setInterval> | null = null;
  const memo = new Map<string, { at: number; view: HistoryView }>();

  function open(): Database {
    if (db) return db;
    const d = new Database(`file:${path}?mode=ro`, { readonly: true });
    d.exec('PRAGMA query_only = ON');
    db = d;
    return d;
  }

  function unreadable(e: unknown): string {
    db?.close();
    db = null;
    return `keeper database unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }

  function readServing(): void {
    const t = now();
    try {
      const rows = open()
        .query<{ account: string; last_jd: number | null; recent: number }, { $since: number }>(SQL.serving)
        .all({ $since: toJulian(t - SERVING_WINDOW_MS) });
      const value = rows.flatMap((r) => (r.last_jd === null ? [] : [{ account: r.account as AccountId, lastAt: fromJulian(r.last_jd), recent: r.recent }]));
      servingSrc = { last: { value, at: t }, error: null, attemptedAt: t, nextAt: (t + SERVING_EVERY_MS) as Instant };
    } catch (e) {
      servingSrc = { ...servingSrc, error: { value: { kind: 'unavailable', message: unreadable(e) }, at: t }, attemptedAt: t, nextAt: (t + SERVING_EVERY_MS) as Instant };
    }
  }

  return {
    start() {
      timer ??= setInterval(readServing, SERVING_EVERY_MS);
      readServing();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      db?.close();
      db = null;
    },
    serving: () => servingSrc,
    history(range, accounts) {
      const t = now();
      const key = `${range}|${[...accounts].sort().join(',')}`;
      const hit = memo.get(key);
      if (hit && t - hit.at < HISTORY_MEMO_MS) return hit.view;
      let view: HistoryView;
      try {
        const d = open();
        const params = { $since: toJulian(t - RANGE_MS[range]), $ids: JSON.stringify(accounts) };
        const hours = d
          .query<TotalsRow & { hour: string; account: string; model: string | null }, typeof params>(SQL.hours)
          .all(params)
          .flatMap((r) => {
            const hour = parseInstant(r.hour);
            return hour === null ? [] : [{ hour, account: r.account as AccountId, model: r.model ?? 'unknown', totals: totals(r) }];
          });
        const models = d
          .query<TotalsRow & { account: string; model: string | null; avg_latency_ms: number | null; avg_ttft_ms: number | null }, typeof params>(SQL.models)
          .all(params)
          .map((r) => ({
            account: r.account as AccountId,
            model: r.model ?? 'unknown',
            totals: totals(r),
            avgLatencyMs: r.avg_latency_ms === null ? null : Math.round(r.avg_latency_ms),
            avgTtftMs: r.avg_ttft_ms === null ? null : Math.round(r.avg_ttft_ms),
          }));
        const errors = d
          .query<
            { id: number; timestamp: string | null; account: string | null; model: string | null; status_code: number | null; auth_quota_reason: string | null; auth_quota_next_recover_at: string | null; body: string | null },
            { $ids: string }
          >(SQL.errors)
          .all({ $ids: params.$ids })
          .map(
            (r): ErrorRow => ({
              id: r.id,
              at: parseInstant(r.timestamp),
              account: (r.account as AccountId | null) ?? null,
              model: r.model,
              status: r.status_code,
              quotaReason: r.auth_quota_reason || null,
              recoverAt: parseInstant(r.auth_quota_next_recover_at),
              message: errorMessage(r.body),
            }),
          );
        const latest = d.query<{ timestamp: string }, []>(SQL.latest).get();
        view = { range, generatedAt: t, keeperLatestAt: parseInstant(latest?.timestamp), hours, models, errors };
      } catch (e) {
        throw new DeckError('unavailable', unreadable(e));
      }
      memo.set(key, { at: t, view });
      return view;
    },
  };
}

function totals(r: TotalsRow): TokenTotals {
  return {
    requests: r.requests,
    failed: r.failed ?? 0,
    rateLimited: r.rate_limited ?? 0,
    freshInput: r.fresh_input ?? 0,
    cacheRead: r.cache_read ?? 0,
    cacheCreation: r.cache_creation ?? 0,
    output: r.output ?? 0,
  };
}

function errorMessage(body: string | null): string {
  if (!body) return '';
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === 'string') return m;
  } catch {
    // SQL.errors cuts bodies at 600 chars, so long ones no longer parse
  }
  return /"message"\s*:\s*"([^"]{1,300})/.exec(body)?.[1] ?? body.slice(0, 300);
}
