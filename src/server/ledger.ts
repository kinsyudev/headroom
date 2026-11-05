import { OUTCOMES, type AccountId, type Effort, type Instant, type Outcome, type TokenSums } from '../shared/domain';
import { LATENCY_SCALE, latencyBin, type Histogram, type UsageCell } from '../shared/usage';

const HOUR_MS = 3_600_000;

/** One usage_events row, parsed by keeper.ts. */
export interface UsageEvent {
  readonly id: number;
  readonly at: Instant;
  readonly account: AccountId;
  readonly model: string;
  readonly effort: Effort;
  readonly outcome: Outcome;
  readonly latencyMs: number | null;
  readonly ttftMs: number | null;
  readonly tokens: TokenSums;
  readonly session: string | null;
}

export function outcomeOf(failed: number | null, status: number | null): Outcome {
  if (status === 429) return 'rate_limited';
  if (status === 499) return 'client_closed';
  if (status !== null && status >= 500 && status < 600) return 'server_error';
  if (failed || (status !== null && status >= 400)) return 'other_error';
  return 'ok';
}

/**
 * The hourly cells keeper's usage_events fold into, keyed by (UTC hour, account, model, effort). The cursor is the
 * highest usage_events id folded, so each row counts once however its reads are sliced or replayed, and a late row
 * with an old timestamp still lands in its own hour.
 */
export interface Ledger {
  readonly cursor: number;
  readonly latestAt: Instant | null;
  /** Folds the events with ids in (cursor, through], then moves the cursor to `through`. Rows it could not parse are simply absent. */
  advance(events: readonly UsageEvent[], through: number): void;
  /**
   * Drops every hour before the one holding `start`. A session counts once, in the cell of its earliest row still
   * held, so a ledger that has run for days holds the same cells as one that just read the horizon from scratch.
   */
  evict(start: Instant): void;
  /** The cells of these accounts, sorted by hour, account, model and effort, copied out. */
  slice(accounts: ReadonlySet<AccountId>): UsageCell[];
}

interface Cell {
  readonly hour: Instant;
  readonly account: AccountId;
  readonly model: string;
  readonly effort: Effort;
  readonly outcomes: Record<Outcome, number>;
  readonly tokens: { -readonly [K in keyof TokenSums]: number };
  sessionsStarted: number;
  latency: Uint32Array | null;
  ttft: Uint32Array | null;
}

/** The earliest row of one session in each cell it touched, and the cell its start is counted in. */
interface SessionSeen {
  readonly earliest: Map<string, { readonly hour: number; readonly at: number }>;
  start: string;
}

export function createLedger(after: number): Ledger {
  const cells = new Map<string, Cell>();
  const sessions = new Map<string, SessionSeen>();
  let cursor = after;
  let latestAt: Instant | null = null;

  const cellOf = (e: UsageEvent): [string, Cell] => {
    const hour = (Math.floor(e.at / HOUR_MS) * HOUR_MS) as Instant;
    const key = `${hour}|${e.account}|${e.model}|${e.effort}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        hour,
        account: e.account,
        model: e.model,
        effort: e.effort,
        outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>,
        tokens: { freshInput: 0, cacheRead: 0, cacheCreation: 0, output: 0, reasoning: 0 },
        sessionsStarted: 0,
        latency: null,
        ttft: null,
      };
      cells.set(key, c);
    }
    return [key, c];
  };

  const fold = (e: UsageEvent) => {
    const [key, c] = cellOf(e);
    c.outcomes[e.outcome]++;
    for (const k of Object.keys(c.tokens) as (keyof TokenSums)[]) c.tokens[k] += e.tokens[k];
    if (e.outcome === 'ok' && e.latencyMs !== null && e.latencyMs >= 0) (c.latency ??= new Uint32Array(LATENCY_SCALE.bins))[latencyBin(e.latencyMs)]!++;
    if (e.outcome === 'ok' && e.ttftMs !== null && e.ttftMs > 0) (c.ttft ??= new Uint32Array(LATENCY_SCALE.bins))[latencyBin(e.ttftMs)]!++;
    if (e.session === null) return;
    let s = sessions.get(e.session);
    if (!s) sessions.set(e.session, (s = { earliest: new Map(), start: '' }));
    const seen = s.earliest.get(key);
    if (!seen || e.at < seen.at) s.earliest.set(key, { hour: c.hour, at: e.at });
    moveStart(s);
  };

  const moveStart = (s: SessionSeen) => {
    let first = '';
    let firstAt = Infinity;
    for (const [key, x] of s.earliest) if (x.at < firstAt) [first, firstAt] = [key, x.at];
    if (first === s.start) return;
    const was = cells.get(s.start);
    if (was) was.sessionsStarted--;
    cells.get(first)!.sessionsStarted++;
    s.start = first;
  };

  return {
    get cursor() {
      return cursor;
    },
    get latestAt() {
      return latestAt;
    },
    advance(events, through) {
      if (through <= cursor) return;
      for (const e of events) {
        if (e.id <= cursor || e.id > through) continue;
        fold(e);
        latestAt = e.at;
      }
      cursor = through;
    },
    evict(start) {
      const first = Math.floor(start / HOUR_MS) * HOUR_MS;
      for (const [key, c] of cells) if (c.hour < first) cells.delete(key);
      for (const [id, s] of sessions) {
        for (const [key, x] of s.earliest) if (x.hour < first) s.earliest.delete(key);
        if (s.earliest.size === 0) sessions.delete(id);
        else moveStart(s);
      }
    },
    slice(accounts) {
      return [...cells.values()]
        .filter((c) => accounts.has(c.account))
        .sort((x, y) => x.hour - y.hour || cmp(x.account, y.account) || cmp(x.model, y.model) || cmp(x.effort, y.effort))
        .map((c) => ({
          hour: c.hour,
          account: c.account,
          model: c.model,
          effort: c.effort,
          tally: { outcomes: { ...c.outcomes }, tokens: { ...c.tokens }, sessionsStarted: c.sessionsStarted, latencyMs: sparse(c.latency), ttftMs: sparse(c.ttft) },
        }));
    },
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sparse(dense: Uint32Array | null): Histogram {
  const out: [number, number][] = [];
  if (dense) for (let i = 0; i < dense.length; i++) if (dense[i]! > 0) out.push([i, dense[i]!]);
  return out;
}
