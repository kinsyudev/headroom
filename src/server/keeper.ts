/**
 * Timestamps carry keeper's +08:00 offset with a fraction of varying length, so they are read through julianday()
 * and compared as instants in JS; the text is never compared. Usage rows are read by primary key only: a slice of the
 * table after the ledger's cursor, never a timestamp range, so no statement scans usage_events.
 */
import { Database } from 'bun:sqlite';
import { DeckError } from '../shared/errors';
import { emptySource, failed, parseInstant, succeeded, type AccountId, type Instant, type ServingSeen, type Source } from '../shared/domain';
import { SERVING_WINDOW_MS } from '../shared/derive';
import { HORIZON_MS, type ErrorEvent, type UsageCube } from '../shared/usage';
import { createLedger, outcomeOf, type Ledger, type UsageEvent } from './ledger';

export const SERVING_EVERY_MS = 5_000;
/** Rows per ingest read. One read folds in a few ms, so /api/snapshot answers between reads during the warm-up. */
export const INGEST_SLICE_ROWS = 2_000;
const ERROR_MESSAGE_CHARS = 300;
const ERROR_BODY_CHARS = 2 * ERROR_MESSAGE_CHARS;

export interface Keeper {
  /** Starts the serving tick and the usage warm-up. Resolves once the warm-up finishes or fails, so a test can await it. */
  start(): Promise<void>;
  stop(): void;
  serving(): Source<readonly ServingSeen[]>;
  /**
   * Usage over the horizon for these accounts, current to keeper's newest row: it reads the tail first. While the
   * warm-up runs it answers with what is folded so far and catchingUp. It throws DeckError('unavailable') when keeper
   * cannot be read.
   */
  usage(accounts: readonly AccountId[]): UsageCube;
}

const KNOWN = /* sql */ `auth_index IN (SELECT value FROM json_each($ids))`;

export const SQL = {
  serving: /* sql */ `
    SELECT auth_index AS account,
           MAX(CASE WHEN COALESCE(failed, 0) = 0 THEN julianday(timestamp) END)                         AS last_jd,
           SUM(CASE WHEN COALESCE(failed, 0) = 0 AND julianday(timestamp) >= $since THEN 1 ELSE 0 END) AS recent
    FROM (SELECT auth_index, timestamp, failed FROM usage_events
          WHERE id > (SELECT MAX(id) FROM usage_events) - 500 ORDER BY id DESC LIMIT 500)
    GROUP BY auth_index`,
  bounds: /* sql */ `SELECT (SELECT MIN(id) FROM usage_events) AS lo, (SELECT MAX(id) FROM usage_events) AS hi`,
  probe: /* sql */ `SELECT id, julianday(timestamp) AS jd FROM usage_events WHERE id >= $id ORDER BY id LIMIT 1`,
  tail: /* sql */ `
    SELECT id, julianday(timestamp) AS jd, auth_index AS account, model, reasoning_effort AS effort,
           failed, status_code AS status, latency_ms, ttft_ms,
           MAX(COALESCE(input_tokens, 0) - cache_read_tokens - cache_creation_tokens, 0) AS fresh_input,
           cache_read_tokens AS cache_read, cache_creation_tokens AS cache_creation,
           COALESCE(output_tokens, 0) AS output, COALESCE(reasoning_tokens, 0) AS reasoning, session_id AS session
    FROM usage_events
    WHERE id > $after
    ORDER BY id
    LIMIT $limit`,
  errors: /* sql */ `
    SELECT id, timestamp, auth_index AS account, model, status_code, auth_quota_reason, auth_quota_next_recover_at,
           substr(body, 1, ${ERROR_BODY_CHARS}) AS body
    FROM error_events
    WHERE ${KNOWN}
    ORDER BY id DESC
    LIMIT 50`,
} as const;

interface TailRow {
  readonly id: number;
  readonly jd: number | null;
  readonly account: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly failed: number | null;
  readonly status: number | null;
  readonly latency_ms: number | null;
  readonly ttft_ms: number | null;
  readonly fresh_input: number;
  readonly cache_read: number;
  readonly cache_creation: number;
  readonly output: number;
  readonly reasoning: number;
  readonly session: string | null;
}

const toJulian = (ms: number) => ms / 86_400_000 + 2_440_587.5;
const fromJulian = (jd: number) => Math.round((jd - 2_440_587.5) * 86_400_000) as Instant;

export function openKeeper(path: string, now: () => Instant): Keeper {
  let db: Database | null = null;
  let servingSrc: Source<readonly ServingSeen[]> = emptySource();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ledger: Ledger | null = null;
  let catchingUp: Promise<void> | null = null;

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
    const attempt = { attemptedAt: t, nextAt: (t + SERVING_EVERY_MS) as Instant };
    try {
      const rows = open()
        .query<{ account: string; last_jd: number | null; recent: number }, { $since: number }>(SQL.serving)
        .all({ $since: toJulian(t - SERVING_WINDOW_MS) });
      const value = rows.flatMap((r) => (r.last_jd === null ? [] : [{ account: r.account as AccountId, lastAt: fromJulian(r.last_jd), recent: r.recent }]));
      servingSrc = succeeded(value, t, attempt);
    } catch (e) {
      servingSrc = failed(servingSrc, { kind: 'unavailable', message: unreadable(e) }, t, attempt);
    }
  }

  /**
   * One bounded read of the rows after the cursor. It starts a ledger at the horizon's first id when there is none,
   * and starts a new one when keeper's newest id is below the cursor, because then the DB was replaced. Returns
   * whether keeper holds more rows than this read took.
   */
  function readSlice(): boolean {
    const d = open();
    const t = now();
    const bounds = d.query<{ lo: number | null; hi: number | null }, []>(SQL.bounds).get();
    if (ledger === null || (bounds?.hi ?? 0) < ledger.cursor) ledger = createLedger(firstIdSince(d, bounds?.lo ?? null, bounds?.hi ?? null, (t - HORIZON_MS) as Instant) - 1);
    const rows = d.query<TailRow, { $after: number; $limit: number }>(SQL.tail).all({ $after: ledger.cursor, $limit: INGEST_SLICE_ROWS });
    if (rows.length > 0) ledger.advance(rows.flatMap(parseEvent), rows.at(-1)!.id);
    ledger.evict((t - HORIZON_MS) as Instant);
    return rows.length === INGEST_SLICE_ROWS;
  }

  /** Reads slices until keeper has no more rows, each in its own macrotask so other requests answer in between. */
  function catchUp(): Promise<void> {
    if (catchingUp) return catchingUp;
    const { promise, resolve } = Promise.withResolvers<void>();
    catchingUp = promise;
    const step = () => {
      let more = false;
      try {
        more = readSlice();
      } catch (e) {
        unreadable(e);
      }
      if (more && timer) setTimeout(step, 0);
      else {
        catchingUp = null;
        resolve();
      }
    };
    step();
    return promise;
  }

  function readErrors(accounts: readonly AccountId[], since: Instant): ErrorEvent[] {
    return open()
      .query<ErrorEventRow, { $ids: string }>(SQL.errors)
      .all({ $ids: JSON.stringify(accounts) })
      .map(
        (r): ErrorEvent => ({
          id: r.id,
          at: parseInstant(r.timestamp),
          account: (r.account as AccountId | null) ?? null,
          model: r.model,
          status: r.status_code,
          outcome: r.status_code === null ? null : outcomeOf(1, r.status_code),
          quotaReason: r.auth_quota_reason || null,
          recoverAt: parseInstant(r.auth_quota_next_recover_at),
          message: errorMessage(r.body),
        }),
      )
      .filter((e) => e.at === null || e.at >= since);
  }

  return {
    start() {
      timer ??= setInterval(() => {
        readServing();
        if (!catchingUp) void catchUp();
      }, SERVING_EVERY_MS);
      readServing();
      return catchUp();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      db?.close();
      db = null;
    },
    serving: () => servingSrc,
    usage(accounts) {
      const t = now();
      try {
        if (!catchingUp && readSlice()) void catchUp();
        if (!ledger) throw new Error('no usage read yet');
        const horizonStart = (t - HORIZON_MS) as Instant;
        return {
          generatedAt: t,
          horizonStart,
          catchingUp: catchingUp !== null,
          keeperLatestAt: ledger.latestAt,
          cells: ledger.slice(new Set(accounts)),
          errors: readErrors(accounts, horizonStart),
        };
      } catch (e) {
        throw new DeckError('unavailable', unreadable(e));
      }
    },
  };
}

interface ErrorEventRow {
  readonly id: number;
  readonly timestamp: string | null;
  readonly account: string | null;
  readonly model: string | null;
  readonly status_code: number | null;
  readonly auth_quota_reason: string | null;
  readonly auth_quota_next_recover_at: string | null;
  readonly body: string | null;
}

/** The first id at or after `since`, by binary search on the primary key with SQL.probe: about 18 lookups for 150k rows. */
function firstIdSince(d: Database, lo: number | null, hi: number | null, since: Instant): number {
  if (lo === null || hi === null) return 1;
  const probe = d.query<{ id: number; jd: number | null }, { $id: number }>(SQL.probe);
  let a = lo;
  let b = hi + 1;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    const row = probe.get({ $id: mid });
    if (row && row.jd !== null && fromJulian(row.jd) < since) a = row.id + 1;
    else b = mid;
  }
  return a;
}

function parseEvent(r: TailRow): UsageEvent[] {
  if (r.jd === null || !r.account) return [];
  const outcome = outcomeOf(r.failed, r.status);
  return [
    {
      id: r.id,
      at: fromJulian(r.jd),
      account: r.account as AccountId,
      model: r.model ?? 'unknown',
      effort: r.effort ?? '',
      outcome,
      latencyMs: r.latency_ms,
      ttftMs: r.ttft_ms,
      tokens: { freshInput: r.fresh_input, cacheRead: r.cache_read, cacheCreation: r.cache_creation, output: r.output, reasoning: r.reasoning },
      session: r.session || null,
    },
  ];
}

const MESSAGE_FIELD = new RegExp(`"message"\\s*:\\s*"([^"]{1,${ERROR_MESSAGE_CHARS}})`);

function errorMessage(body: string | null): string {
  if (!body) return '';
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === 'string') return m;
  } catch {
  }
  return MESSAGE_FIELD.exec(body)?.[1] ?? body.slice(0, ERROR_MESSAGE_CHARS);
}
