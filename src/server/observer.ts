/**
 * The single writer of the CPA account list and the routing strategy. /auth-files every 5 s and
 * /routing/strategy every 60 s; both are local and cost nothing upstream. Handlers never write
 * these: after a mutation they call `refresh()` and answer once the new state is published.
 */
import { z } from 'zod';
import { DeckError } from '../shared/actions';
import { emptySource, type CpaAccount, type Instant, type RoutingStrategy, type Source, type SourceError } from '../shared/domain';
import type { Cpa } from './cpa';

export const CPA_EVERY_MS = 5_000;
export const STRATEGY_EVERY_MS = 60_000;

export interface Observer {
  start(): void;
  stop(): void;
  cpa(): Source<readonly CpaAccount[]>;
  strategy(): Source<RoutingStrategy>;
  /** The last known list, or [] before the first answer. */
  accounts(): readonly CpaAccount[];
  /** Re-reads both now. Never throws; a failure lands in the Source. */
  refresh(): Promise<Instant>;
}

export function createObserver(deps: { readonly cpa: Cpa; readonly now: () => Instant }): Observer {
  let accounts: Source<readonly CpaAccount[]> = emptySource();
  let strategy: Source<RoutingStrategy> = emptySource();
  let accountsBusy = false;
  let strategyBusy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function readAccounts(): Promise<Instant> {
    const attempted = deps.now();
    try {
      const r = await deps.cpa.listAccounts();
      accounts = { last: { value: r.accounts, at: r.observedAt }, error: null, attemptedAt: attempted, nextAt: (attempted + CPA_EVERY_MS) as Instant };
      return r.observedAt;
    } catch (e) {
      accounts = { ...accounts, error: { value: toSourceError(e), at: deps.now() }, attemptedAt: attempted, nextAt: (attempted + CPA_EVERY_MS) as Instant };
      return deps.now();
    }
  }

  async function readStrategy(): Promise<void> {
    const attempted = deps.now();
    try {
      const value = await deps.cpa.getStrategy();
      strategy = { last: { value, at: deps.now() }, error: null, attemptedAt: attempted, nextAt: (attempted + STRATEGY_EVERY_MS) as Instant };
    } catch (e) {
      strategy = { ...strategy, error: { value: toSourceError(e), at: deps.now() }, attemptedAt: attempted, nextAt: (attempted + STRATEGY_EVERY_MS) as Instant };
    }
  }

  function tick(): void {
    const now = deps.now();
    if (!accountsBusy && (accounts.nextAt === null || now >= accounts.nextAt)) {
      accountsBusy = true;
      void readAccounts().finally(() => (accountsBusy = false));
    }
    if (!strategyBusy && (strategy.nextAt === null || now >= strategy.nextAt)) {
      strategyBusy = true;
      void readStrategy().finally(() => (strategyBusy = false));
    }
  }

  return {
    start() {
      timer ??= setInterval(tick, 1_000);
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    cpa: () => accounts,
    strategy: () => strategy,
    accounts: () => accounts.last?.value ?? [],
    async refresh() {
      const [at] = await Promise.all([readAccounts(), readStrategy()]);
      return at;
    },
  };
}

function toSourceError(e: unknown): SourceError {
  if (e instanceof DeckError) {
    if (e.code === 'link_down') return { kind: 'link_down' };
    if (e.code === 'cpa_unreachable') return { kind: 'cpa_unreachable' };
    return { kind: 'upstream', status: Number(/\d{3}/.exec(e.message)?.[0] ?? 0), message: e.message };
  }
  if (e instanceof z.ZodError) return { kind: 'malformed', message: e.issues[0]?.message ?? 'schema mismatch' };
  return { kind: 'malformed', message: e instanceof Error ? e.message : String(e) };
}
