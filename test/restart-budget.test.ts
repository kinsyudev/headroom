import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '../src/server/anthropic';
import type { Cpa, UpstreamRequest, UpstreamResult } from '../src/server/cpa';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import type { AccountId, CpaAccount } from '../src/shared/domain';
import { ACC1, ACC2, ACC3, FakeClock, FIXTURES, MIN, T0, cpaAccounts } from './support';

const N: Record<string, number> = { [ACC2]: 1, [ACC1]: 2, [ACC3]: 3 };
const body = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const ok = (b: string): UpstreamResult => ({ kind: 'answered', status: 200, headers: {}, body: b });
const LIMITED: UpstreamResult = {
  kind: 'answered',
  status: 429,
  headers: {},
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }),
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function restartLoop(opts: { readonly totalMs: number; readonly lifeMs: number; readonly accounts?: readonly CpaAccount[]; readonly always429?: boolean; readonly step?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-restart-'));
  dirs.push(dir);
  const clock = new FakeClock(T0);
  const usage: { at: number; account: AccountId; status: number }[] = [];
  const cpa = {
    link: () => ({ kind: 'ok' }),
    apiCall: async (req: UpstreamRequest): Promise<UpstreamResult> => {
      const u = new URL(req.url);
      const n = N[req.account];
      if (u.pathname === '/api/oauth/profile') return ok(body(`anthropic-profile-${n}.json`));
      const recent = usage.filter((c) => c.account === req.account && clock.now() - c.at < 15 * MIN).length;
      const r = opts.always429 || recent >= 12 ? LIMITED : ok(body(u.search.includes('at_wall=1') ? `anthropic-usage-at-wall-${n}.json` : `anthropic-usage-${n}.json`));
      usage.push({ at: clock.now(), account: req.account, status: r.kind === 'answered' ? r.status : 0 });
      return r;
    },
  } as unknown as Cpa;
  const accounts = opts.accounts ?? cpaAccounts();
  const step = opts.step ?? 1_000;
  for (let lived = 0; lived < opts.totalMs; lived += opts.lifeMs) {
    const state = openStateFile(join(dir, 'state.json'));
    const poller = createPoller({ anthropic: createAnthropic({ cpa, cliVersion: '2.1.311', clock, state }), accounts: () => accounts, linkOk: () => true, clock });
    for (let t = 0; t < opts.lifeMs; t += step) {
      poller.tick();
      await clock.advance(step);
    }
    poller.stop();
  }
  const of = (id: AccountId) => usage.filter((c) => c.account === id);
  const minutesApart = (id: AccountId) => of(id).slice(1).map((c, i) => Math.round((c.at - of(id)[i]!.at) / MIN));
  return { of, minutesApart, earned429: usage.filter((c) => c.status === 429).length };
}

const only = (id: AccountId) => cpaAccounts().filter((a) => a.id === id);

describe('the budget survives restarts', () => {
  for (const lifeMs of [30_000, 50_000, 60_000]) {
    test(`restarting every ${lifeMs / 1000} s for 15 min reads no account more often than one long-lived process`, async () => {
      const once = await restartLoop({ totalMs: 15 * MIN, lifeMs: 15 * MIN });
      const loop = await restartLoop({ totalMs: 15 * MIN, lifeMs });
      for (const id of [ACC2, ACC1, ACC3]) expect(loop.of(id).length, id).toBeLessThanOrEqual(once.of(id).length);
      expect(loop.earned429).toBe(0);
    });
  }

  test('a restart 30 s after a read does not read the account again', async () => {
    const r = await restartLoop({ totalMs: 60_000, lifeMs: 30_000, accounts: only(ACC1) });
    expect(r.of(ACC1)).toHaveLength(1);
  });

  for (const lifeMs of [6 * MIN, 60_000]) {
    test(`while every read 429s, restarting every ${lifeMs / 1000} s still climbs the ladder: 5, 10, 20, then 30 min`, async () => {
      const r = await restartLoop({ totalMs: 100 * MIN, lifeMs, accounts: only(ACC1), always429: true, step: 5_000 });
      expect(r.minutesApart(ACC1).slice(0, 5)).toEqual([5, 10, 20, 30, 30]);
    });
  }
});

describe('the last readings survive restarts', () => {
  test('a restarted deck shows the previous reads with their real age and does not re-read the profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-samples-'));
    dirs.push(dir);
    const clock = new FakeClock(T0);
    const calls: { at: number; path: string }[] = [];
    const cpa = {
      link: () => ({ kind: 'ok' }),
      apiCall: async (req: UpstreamRequest): Promise<UpstreamResult> => {
        const u = new URL(req.url);
        calls.push({ at: clock.now(), path: u.pathname });
        if (u.pathname === '/api/oauth/profile') return ok(body('anthropic-profile-1.json'));
        return ok(body('anthropic-usage-1.json'));
      },
    } as unknown as Cpa;
    const accounts = only(ACC2);
    const boot = () => {
      const state = openStateFile(join(dir, 'state.json'));
      return createPoller({ anthropic: createAnthropic({ cpa, cliVersion: '2.1.311', clock, state }), accounts: () => accounts, linkOk: () => true, clock, state });
    };

    const first = boot();
    for (let t = 0; t < 60_000; t += 1_000) {
      first.tick();
      await clock.advance(1_000);
    }
    first.stop();
    const readAt = first.feeds()[ACC2]!.limits.last!.at;
    const profileCalls = calls.filter((c) => c.path === '/api/oauth/profile').length;

    await clock.advance(30_000);
    const second = boot();
    second.tick();
    const restored = second.feeds()[ACC2]!;
    expect(restored.limits.last?.at, 'limits restored with their original read time').toBe(readAt);
    expect(restored.limits.last?.value.length, 'limits restored with their values').toBeGreaterThan(0);
    expect(restored.profile.last?.value.orgUuid, 'profile restored').toBeTruthy();
    for (let t = 0; t < 60_000; t += 1_000) {
      second.tick();
      await clock.advance(1_000);
    }
    second.stop();
    expect(calls.filter((c) => c.path === '/api/oauth/profile').length, 'no profile re-read after restart').toBe(profileCalls);
  });
});
