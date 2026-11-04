/**
 * GET /api/history. keeper.ts returns sparse rows bucketed by UTC hour, per account and model.
 * The browser folds them into local hours or days with `foldHistory`, so time zone and DST rules
 * stay out of SQL and come from the operator's own clock.
 */
import type { AccountId, Instant } from './domain';

export type HistoryRange = '24h' | '7d' | '30d';
export const HISTORY_RANGES: readonly HistoryRange[] = ['24h', '7d', '30d'];
export const RANGE_MS: Readonly<Record<HistoryRange, number>> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/**
 * `freshInput` is input_tokens minus cache reads and cache creation. For Claude, keeper's
 * input_tokens already includes both, so raw input would double-count cache. Raw input is not
 * exposed, so nobody can sum it by mistake.
 */
export interface TokenTotals {
  readonly requests: number;
  readonly failed: number;
  readonly rateLimited: number;
  readonly freshInput: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly output: number;
}

export interface HourRow {
  /** Start of the UTC hour. */
  readonly hour: Instant;
  readonly account: AccountId;
  readonly model: string;
  readonly totals: TokenTotals;
}

export interface ModelRow {
  readonly account: AccountId;
  readonly model: string;
  readonly totals: TokenTotals;
  readonly avgLatencyMs: number | null;
  readonly avgTtftMs: number | null;
}

export interface ErrorRow {
  readonly id: number;
  readonly at: Instant | null;
  readonly account: AccountId | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly quotaReason: string | null;
  readonly recoverAt: Instant | null;
  readonly message: string;
}

export interface HistoryView {
  readonly range: HistoryRange;
  readonly generatedAt: Instant;
  /** keeper's newest usage_events row. */
  readonly keeperLatestAt: Instant | null;
  readonly hours: readonly HourRow[];
  /** Per account and model over exactly the last range. */
  readonly models: readonly ModelRow[];
  /** The 50 newest error_events for the known accounts, newest first. */
  readonly errors: readonly ErrorRow[];
}

export const ZERO_TOTALS: TokenTotals = { requests: 0, failed: 0, rateLimited: 0, freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0 };

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    requests: a.requests + b.requests,
    failed: a.failed + b.failed,
    rateLimited: a.rateLimited + b.rateLimited,
    freshInput: a.freshInput + b.freshInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    output: a.output + b.output,
  };
}

export interface HistoryBucket {
  readonly start: Instant;
  readonly end: Instant;
  readonly byAccount: ReadonlyMap<AccountId, TokenTotals>;
}

/**
 * Contiguous, zero-filled local buckets: 24 hours for '24h', else one bucket per local day,
 * stepping by calendar date so a DST day is 23 or 25 hours long. Uses the runtime's time zone.
 */
export function foldHistory(rows: readonly HourRow[], range: HistoryRange, now: Instant): { bucket: 'hour' | 'day'; buckets: HistoryBucket[] } {
  const starts: number[] = [];
  if (range === '24h') {
    const top = Math.floor(now / 3_600_000) * 3_600_000;
    for (let i = 23; i >= -1; i--) starts.push(top - i * 3_600_000);
  } else {
    const days = range === '7d' ? 7 : 30;
    const d = new Date(now);
    for (let i = days - 1; i >= -1; i--) starts.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime());
  }
  const sums = starts.slice(0, -1).map(() => new Map<AccountId, TokenTotals>());
  for (const r of rows) {
    const i = lastIndexAtOrBefore(starts, r.hour);
    if (i < 0 || i >= sums.length) continue;
    const m = sums[i]!;
    m.set(r.account, addTotals(m.get(r.account) ?? ZERO_TOTALS, r.totals));
  }
  return {
    bucket: range === '24h' ? 'hour' : 'day',
    buckets: sums.map((byAccount, i) => ({ start: starts[i] as Instant, end: starts[i + 1] as Instant, byAccount })),
  };
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
