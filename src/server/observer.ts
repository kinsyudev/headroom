/** /auth-files every 5 s and /routing/strategy every 60 s; both are local and cost nothing upstream. */
import { z } from 'zod';
import { DeckError } from '../shared/errors';
import { emptySource, failed, succeeded, type CpaAccount, type Instant, type RoutingStrategy, type Source, type SourceError } from '../shared/domain';
import type { Cpa } from './cpa';

export const CPA_EVERY_MS = 5_000;
export const STRATEGY_EVERY_MS = 60_000;

export interface Observer {
  start(): void;
  stop(): void;
  cpa(): Source<readonly CpaAccount[]>;
  strategy(): Source<RoutingStrategy>;
  accounts(): readonly CpaAccount[];
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
    const attempt = { attemptedAt: attempted, nextAt: (attempted + CPA_EVERY_MS) as Instant };
    try {
      const r = await deps.cpa.listAccounts();
      accounts = succeeded(r.accounts, r.observedAt, attempt);
      return r.observedAt;
    } catch (e) {
      accounts = failed(accounts, toSourceError(e), deps.now(), attempt);
      return deps.now();
    }
  }

  async function readStrategy(): Promise<void> {
    const attempted = deps.now();
    const attempt = { attemptedAt: attempted, nextAt: (attempted + STRATEGY_EVERY_MS) as Instant };
    try {
      const value = await deps.cpa.getStrategy();
      strategy = succeeded(value, deps.now(), attempt);
    } catch (e) {
      strategy = failed(strategy, toSourceError(e), deps.now(), attempt);
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
