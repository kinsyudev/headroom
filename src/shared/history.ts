/**
 * History types: the response of GET /api/history. Built by server/keeper.ts from keeper's SQLite.
 * They're separate from Snapshot because history is pulled on demand (the history panel, every 60 s),
 * not pushed. It's bigger and changes slowly.
 */
import type { AccountId, Instant } from './domain';

export type HistoryRange = '24h' | '7d' | '30d';
export const HISTORY_BUCKET: Readonly<Record<HistoryRange, 'hour' | 'day'>> = { '24h': 'hour', '7d': 'day', '30d': 'day' };

/**
 * Token totals for a set of requests.
 * `freshInput` = Σ max(input_tokens - cache_read_tokens - cache_creation_tokens, 0).
 * For Claude, keeper's `input_tokens` already includes both cache counts, so the raw input_tokens
 * would double-count cache. Raw input_tokens is deliberately not exposed, so it can't be summed by mistake.
 */
export interface TokenTotals {
  readonly requests: number;
  readonly failed: number;
  readonly rateLimited: number; // status_code 429
  readonly freshInput: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly output: number;
  readonly reasoning: number;
}

export interface HistoryBucket {
  /** Local-time bucket start (local midnight for 'day', so DST days are 23 or 25 h long). */
  readonly start: Instant;
  readonly byAccount: Readonly<Record<AccountId, TokenTotals>>;
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
  readonly code: string | null;
  readonly quotaReason: string | null;
  readonly recoverAt: Instant | null;
  /** `error.message` parsed from the body when it's JSON, else the first 300 chars. */
  readonly message: string;
}

export interface HistoryView {
  readonly range: HistoryRange;
  readonly bucket: 'hour' | 'day';
  readonly generatedAt: Instant;
  /** Freshness of keeper itself: its newest usage_events row. */
  readonly keeperLatestAt: Instant | null;
  /** Contiguous from range start to now, zero-filled. Charts never need to fill gaps. */
  readonly series: readonly HistoryBucket[];
  readonly models: readonly ModelRow[];
  /** The 50 most recent error_events rows, newest first. */
  readonly errors: readonly ErrorRow[];
}
