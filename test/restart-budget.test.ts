/**
 * The Anthropic budget across process restarts, the way a LaunchAgent restart loop produces
 * them. Each life is a fresh createAnthropic and createPoller over the same state.json on one
 * virtual clock. The stub stands in for CPA's api-call and behaves like Anthropic's measured
 * limiter: a 13th usage call for one account inside 15 minutes answers 429.
 * Ported from the adversarial review's restart repros.
 */
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

/** Runs `totalMs` of deck time as lives of `lifeMs` each and returns every usage read that left. */
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
