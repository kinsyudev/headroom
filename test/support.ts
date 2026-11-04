import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAuthFiles } from '../src/server/cpa';
import { parseProfile, parseUsage, type Clock, type UsageRead } from '../src/server/anthropic';
import {
  emptyFeeds,
  emptySource,
  type AccountFeeds,
  type AccountId,
  type ClaimRecord,
  type CpaAccount,
  type Instant,
  type ReadMode,
  type RoutingStrategy,
  type ServingSeen,
  type Snapshot,
} from '../src/shared/domain';

export const FIXTURES = join(import.meta.dir, 'fixtures');
export const T0 = parseAuthFiles(fixture('cpa-auth-files.json')).observedAt;
export const at = (iso: string) => Date.parse(iso) as Instant;
export const plus = (t: Instant, ms: number) => (t + ms) as Instant;
export const MIN = 60_000;

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const accountIdOf = (email: string): AccountId => cpaAccounts().find((a) => a.email === email)!.id;

export const ACC1 = accountIdOf('account1@example.com');
export const ACC2 = accountIdOf('account2@example.com');
export const ACC3 = accountIdOf('account3@example.com');

export function cpaAccounts(): readonly CpaAccount[] {
  return parseAuthFiles(fixture('cpa-auth-files.json')).accounts;
}

export function account(id: AccountId, accounts = cpaAccounts()): CpaAccount {
  return accounts.find((a) => a.id === id)!;
}

export function usage(name: string, mode: ReadMode): UsageRead {
  return parseUsage(fixture(name), mode);
}

export function feedsFrom(read: UsageRead, t: Instant, profileFixture?: string): AccountFeeds {
  const sample = <T>(value: T) => ({ ...emptySource<T>(), last: { value, at: t }, attemptedAt: t });
  const f = emptyFeeds();
  return {
    ...f,
    limits: sample(read.limits),
    cedar: sample(read.cedar),
    ...(read.mode === 'normal' ? { spend: sample(read.spend) } : { juniper: sample(read.juniper) }),
    ...(profileFixture ? { profile: sample(parseProfile(fixture(profileFixture))) } : {}),
  };
}

export function snapshot(parts: {
  readonly accounts?: readonly CpaAccount[];
  readonly feeds?: Record<AccountId, AccountFeeds>;
  readonly serving?: readonly ServingSeen[] | null;
  readonly strategy?: RoutingStrategy;
  readonly claims?: readonly ClaimRecord[];
  readonly now?: Instant;
}): Snapshot {
  const now = parts.now ?? T0;
  return {
    generatedAt: now,
    link: { kind: 'ok' },
    cpa: { ...emptySource(), last: { value: parts.accounts ?? cpaAccounts(), at: now } },
    strategy: { ...emptySource(), last: { value: parts.strategy ?? 'fill-first', at: now } },
    feeds: parts.feeds ?? {},
    serving:
      parts.serving === undefined || parts.serving === null
        ? { ...emptySource(), error: { value: { kind: 'unavailable', message: 'test' }, at: now } }
        : { ...emptySource(), last: { value: parts.serving, at: now } },
    claims: parts.claims ?? [],
    flows: [],
  };
}

export class FakeClock implements Clock {
  private timers: { at: number; resolve: () => void }[] = [];
  constructor(private t: number) {}
  now(): Instant {
    return this.t as Instant;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.timers.push({ at: this.t + ms, resolve }));
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await settle();
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.resolve();
    }
    this.t = target;
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}
