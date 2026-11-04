/**
 * Reset claims end to end against the fake CPA: the real cpa, anthropic, poller and claims
 * modules, with the 10 s gap and the follow-up spacing shrunk so the suite runs in seconds.
 * The fake records every reset_rate_limits and reset-quota it receives.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeckError } from '../src/shared/errors';
import { createAnthropic, realClock } from '../src/server/anthropic';
import { createClaims } from '../src/server/claims';
import { Secret } from '../src/server/config';
import { createCpa } from '../src/server/cpa';
import { createObserver } from '../src/server/observer';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import { deriveOffers } from '../src/shared/derive';
import type { GrantId } from '../src/shared/domain';
import { startFakeCpa, type FakeCpa } from './fake-cpa';
import { ACC1, ACC3 } from './support';

const KEY = 'test-management-key';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function rig(opts: { claimTimeoutMs?: number; before?: (fake: FakeCpa) => void } = {}) {
  const fake = startFakeCpa({ key: KEY });
  const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-claims-'));
  cleanups.push(() => fake.stop(), () => rmSync(dir, { recursive: true, force: true }));
  const state = openStateFile(join(dir, 'state.json'));
  const cpa = createCpa({ baseUrl: fake.url, envPath: '/dev/null', readKey: () => Secret.from(KEY), state, now: realClock.now });
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock: realClock, state, gapMs: 0, claimTimeoutMs: opts.claimTimeoutMs ?? 5_000 });
  const observer = createObserver({ cpa, now: realClock.now });
  await observer.refresh();
  const poller = createPoller({ anthropic, accounts: observer.accounts, linkOk: () => true, clock: realClock, staggerMs: 0 });
  poller.tick();
  for (let i = 0; i < 100 && !(poller.profile(ACC3) && poller.profile(ACC1)); i++) await Bun.sleep(10);
  opts.before?.(fake);
  const claims = createClaims({ anthropic, cpa, poller, clock: realClock, followupGapMs: 10 });
  const sends = () => fake.mutations.filter((m) => m.path.endsWith('/reset_rate_limits'));
  const resetQuotas = () => fake.mutations.filter((m) => m.path === '/reset-quota');
  return { fake, claims, poller, sends, resetQuotas };
}

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof DeckError ? `${e.code}: ${e.message}` : String(e);
  }
};

describe('claims against the fake CPA', () => {
  test('a double-click sends once: both callers get the same settled record', async () => {
    const r = await rig();
    const [a, b] = await Promise.all([
      r.claims.claim({ account: ACC3, program: 'juniper_tide' }),
      r.claims.claim({ account: ACC3, program: 'juniper_tide' }),
    ]);
    expect(a).toBe(b);
    expect(r.sends()).toHaveLength(1);
    expect(r.sends()[0]!.body).toEqual({ auth_index: ACC3, program: 'juniper_tide' });
    expect(a.state).toMatchObject({ kind: 'settled', outcome: { result: 'reset' }, followup: 'done' });
  });

  test('reset triggers CPA reset-quota for that account', async () => {
    const r = await rig();
    await r.claims.claim({ account: ACC3, program: 'juniper_tide' });
    expect(r.resetQuotas().map((m) => m.body)).toEqual([{ auth_index: ACC3 }]);
  });

  test('a repeat after the claim landed is refused by the fresh read, and nothing more is sent', async () => {
    const r = await rig();
    await r.claims.claim({ account: ACC3, program: 'juniper_tide' });
    expect(await reason(r.claims.claim({ account: ACC3, program: 'juniper_tide' }))).toMatch(/^not_claimable: waiting until/);
    expect(r.sends()).toHaveLength(1);
  });

  test('a read that cannot be made refuses as stale and sends nothing', async () => {
    const r = await rig({ before: (fake) => fake.rateLimited.add(ACC3) });
    expect(await reason(r.claims.claim({ account: ACC3, program: 'juniper_tide' }))).toMatch(/^not_claimable: stale: .*rate-limited until/);
    expect(await reason(r.claims.claim({ account: ACC3, program: 'cedar_ember' }))).toMatch(/^not_claimable: stale: .*rate-limited until/);
    expect(r.sends()).toHaveLength(0);
  });

  test('fresh data that says no is explained and sends nothing', async () => {
    const r = await rig();
    expect(await reason(r.claims.claim({ account: ACC1, program: 'juniper_tide' }))).toBe('not_claimable: not enrolled in this program');
    expect(await reason(r.claims.claim({ account: ACC1, program: 'cedar_ember' }))).toMatch(/^not_claimable: ineligible \(no_grant\)/);
    expect(r.sends()).toHaveLength(0);
  });

  test('cedar_ember sends the grant and a request_id equal to the claim id', async () => {
    const r = await rig();
    const rec = await r.claims.claim({ account: ACC3, program: 'cedar_ember' });
    expect(r.sends()[0]!.body).toEqual({ auth_index: ACC3, program: 'cedar_ember', grant_id: 'grant_example_1', request_id: rec.id });
    expect(rec).toMatchObject({ grant: 'grant_example_1' as GrantId, state: { kind: 'settled', outcome: { result: 'reset', resetsLeft: 1, cleared: ['five_hour'] } } });
  });

  test('a timeout records unknown, never failed, and skips reset-quota', async () => {
    const r = await rig({ claimTimeoutMs: 200, before: (fake) => (fake.claimDelayMs = 1_000) });
    const rec = await r.claims.claim({ account: ACC3, program: 'juniper_tide' });
    expect(rec.state).toMatchObject({ kind: 'unknown', why: 'timed out waiting for CPA' });
    expect(r.sends()).toHaveLength(1);
    expect(r.resetQuotas()).toHaveLength(0);

    const feeds = r.poller.feeds()[ACC3]!;
    const offer = deriveOffers(ACC3, feeds, true, r.claims.list(), realClock.now()).find((o) => o.program === 'juniper_tide')!;
    expect(offer.state).toEqual({ kind: 'in_flight', claim: rec.id, unknown: true });
  });

  test('reset-quota is tried at most 3 times, then the claim reports the follow-up failed', async () => {
    const r = await rig({ before: (fake) => (fake.failResetQuota = 5) });
    const rec = await r.claims.claim({ account: ACC3, program: 'juniper_tide' });
    expect(rec.state).toMatchObject({ kind: 'settled', outcome: { result: 'reset' }, followup: 'failed' });
    expect(r.resetQuotas()).toHaveLength(3);
  });

  test('every request carried the Claude Code identity', async () => {
    const r = await rig();
    await r.claims.claim({ account: ACC3, program: 'juniper_tide' });
    expect(r.fake.calls.length).toBeGreaterThan(0);
    for (const c of r.fake.calls) expect([c.userAgent, c.xApp]).toEqual(['claude-cli/2.1.311 (external, cli)', 'cli']);
  });
});
