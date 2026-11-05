import type { AccountId, Effort, Instant, Outcome, TokenSums } from './domain';
import type { Grain, UsageRange } from './view';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** What each range spans and its default grain. */
const RANGE_SPAN: Readonly<Record<UsageRange, { readonly ms: number; readonly grain: Grain }>> = {
  '24h': { ms: 24 * HOUR_MS, grain: 'hour' },
  '7d': { ms: 7 * DAY_MS, grain: 'day' },
  '30d': { ms: 30 * DAY_MS, grain: 'day' },
};

/** How far back the cube reaches: the longest range plus one day, so the oldest local day of a 30d lens is whole in every zone. */
export const HORIZON_MS: number = Math.max(...Object.values(RANGE_SPAN).map((r) => r.ms)) + DAY_MS;

/**
 * The one latency histogram scheme: the ledger writes with it and deriveAnalytics reads with it. Bin i holds
 * [floorMs·2^(i/binsPerDoubling), floorMs·2^((i+1)/binsPerDoubling)). Bin 0 also holds anything faster and the last
 * bin anything slower. 4 bins per doubling is ±9% per bin, and 72 bins reach about 7 h.
 */
export const LATENCY_SCALE = { floorMs: 100, binsPerDoubling: 4, bins: 72 } as const;

export function latencyBin(ms: number): number {
  const { floorMs, binsPerDoubling, bins } = LATENCY_SCALE;
  return Math.min(bins - 1, Math.max(0, Math.floor(Math.log2(Math.max(ms, floorMs) / floorMs) * binsPerDoubling)));
}

/**
 * Hourly usage over the horizon as the server read it from keeper: the one analytics shape. The server builds it,
 * /api/usage carries it unchanged, and deriveAnalytics folds it. It holds no range or time-zone decision.
 *  - cells are sorted by hour, account, model and effort, and that tuple is unique.
 *  - hour is a whole UTC hour, which folds exactly into any whole-hour local zone.
 *  - every measure in a Tally adds up across cells. Percentiles are the one approximation, to a bin.
 *  - only the accounts CPA currently knows appear.
 */
export interface UsageCube {
  readonly generatedAt: Instant;
  readonly horizonStart: Instant;
  /** The server is still reading the horizon, so the cells hold only part of it. */
  readonly catchingUp: boolean;
  /** Timestamp of the newest usage_events row read. */
  readonly keeperLatestAt: Instant | null;
  readonly cells: readonly UsageCell[];
  /** The newest error_events inside the horizon, newest first. */
  readonly errors: readonly ErrorEvent[];
}

export interface UsageCell {
  readonly hour: Instant;
  readonly account: AccountId;
  readonly model: string;
  readonly effort: Effort;
  readonly tally: Tally;
}

/** No `requests` field: it is the sum of outcomes, so the two cannot disagree. */
export interface Tally {
  readonly outcomes: Readonly<Record<Outcome, number>>;
  readonly tokens: TokenSums;
  /** Sessions whose first request inside the horizon landed in this cell. */
  readonly sessionsStarted: number;
  /** Ok requests only. A failed request's latency measures the failure, not the model. */
  readonly latencyMs: Histogram;
  /** Ok requests that reported a time to first token. */
  readonly ttftMs: Histogram;
}

/** Sparse, sorted by bin, with no zero counts. */
export type Histogram = readonly HistogramBin[];
export type HistogramBin = readonly [bin: number, count: number];

export interface ErrorEvent {
  readonly id: number;
  readonly at: Instant | null;
  readonly account: AccountId | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly outcome: Outcome | null;
  readonly quotaReason: string | null;
  readonly recoverAt: Instant | null;
  /** The upstream error message, parsed out of the body. The body itself never leaves keeper.ts. */
  readonly message: string;
}
