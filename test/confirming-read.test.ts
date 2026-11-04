import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '../src/server/anthropic';
import { createClaims } from '../src/server/claims';
import type { Cpa, UpstreamRequest, UpstreamResult } from '../src/server/cpa';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import { deriveDeck } from '../src/shared/derive';
import type { CpaAccount, Instant, Percent } from '../src/shared/domain';
import { ACC1, FakeClock, FIXTURES, MIN, T0, account, snapshot } from './support';

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

function consumed(): string {
  const w = JSON.parse(body('synthetic-usage-at-wall-claimable.json'));
  for (const l of w.limits) if (l.kind === 'session') Object.assign(l, { percent: 0, severity: 'normal', is_active: false });
  Object.assign(w.juniper_tide, { available: false, next_available_at: '2026-11-11T09:00:00Z' });
  return JSON.stringify(w);
}

test('a confirming wall read that 429s stays wanted, so the claim resolves once reads succeed again', async () => {
  const clock = new FakeClock(T0);
  const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-confirm-'));
  dirs.push(dir);
  const sent: { at: number; path: string; status: number }[] = [];
  let claimed = false;
  let fail429 = 0;
  const a = account(ACC1);
  let accounts: readonly CpaAccount[] = [a];
  const cpa = {
    link: () => ({ kind: 'ok' }),
    clearCooldown: async () => undefined,
    apiCall: async (req: UpstreamRequest): Promise<UpstreamResult> => {
      const u = new URL(req.url);
      const path = u.pathname + u.search;
      let r: UpstreamResult;
      if (u.pathname === '/api/oauth/profile') r = ok(body('anthropic-profile-2.json'));
      else if (u.pathname.endsWith('/reset_rate_limits')) {
        claimed = true;
        fail429 = 1;
        accounts = [{ ...a, headers: { ...a.headers!, observedAt: clock.now(), windows: a.headers!.windows.map((w) => (w.key === '5h' ? { ...w, percent: 1 as Percent } : w)) } }];
        r = ok(JSON.stringify({ result: 'reset', next_available_at: '2026-11-11T09:00:00Z', weekly_resets_at: null }));
      } else if (fail429 > 0) {
        fail429 -= 1;
        r = LIMITED;
      } else if (u.search.includes('at_wall=1')) r = ok(claimed ? consumed() : body('synthetic-usage-at-wall-claimable.json'));
      else r = ok(body('anthropic-usage-2.json'));
      sent.push({ at: clock.now(), path, status: r.kind === 'answered' ? r.status : 0 });
      return r;
    },
  } as unknown as Cpa;
  const state = openStateFile(join(dir, 'state.json'));
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock, state });
  const poller = createPoller({ anthropic, accounts: () => accounts, linkOk: () => true, clock });
  const claims = createClaims({ anthropic, cpa, poller, clock });
  const run = async (ms: number, step = 1_000) => {
    for (let t = 0; t < ms; t += step) {
      poller.tick();
      await clock.advance(step);
    }
  };
  const juniper = () =>
    deriveDeck(snapshot({ accounts, feeds: poller.feeds(), claims: claims.list(), now: clock.now() }), clock.now()).accounts[0]!.offers.find((o) => o.program === 'juniper_tide')!;

  await run(40_000);
  const outcome = claims.claim({ account: ACC1, program: 'juniper_tide' });
  await run(30_000);
  const rec = await outcome;
  expect(rec.state).toMatchObject({ kind: 'settled', outcome: { result: 'reset' } });
  const endedAt = (rec.state as { at: Instant }).at;
  await run(6 * 60 * MIN, 5_000);

  const after = sent.filter((s) => s.at > endedAt && s.path.startsWith('/api/oauth/usage'));
  expect(after.find((s) => s.status === 429)?.path).toBe('/api/oauth/usage?at_wall=1&skip_spend=1');
  expect(after.some((s) => s.status === 200 && s.path.includes('at_wall=1'))).toBe(true);
  expect(juniper().state).toEqual({ kind: 'held', lastAt: expect.any(Number), lastClaimable: false });
  expect(juniper().dataAt!).toBeGreaterThan(endedAt);
});
