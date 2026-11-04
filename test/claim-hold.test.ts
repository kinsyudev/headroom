/**
 * A claim whose outcome is unknown must not be sent twice. Our wait gives up after 200 ms while
 * the fake CPA takes 1 s to apply the claim, so a wall read can be answered before the first
 * claim lands and still show the old offer. Real cpa, anthropic, poller and claims against the
 * fake CPA, which records every reset_rate_limits it receives.
 * Ported from the adversarial review's claim repros (timeout race, unknown outcome, re-offer).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic, realClock } from '../src/server/anthropic';
import { createClaims } from '../src/server/claims';
import { Secret } from '../src/server/config';
import { createCpa } from '../src/server/cpa';
import { createObserver } from '../src/server/observer';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import { deriveDeck } from '../src/shared/derive';
import type { ProgramId } from '../src/shared/domain';
import { DeckError } from '../src/shared/errors';
import { startFakeCpa } from './fake-cpa';
import { ACC3, snapshot } from './support';

const KEY = 'test-management-key';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function rig() {
  const fake = startFakeCpa({ key: KEY });
  const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-hold-'));
  cleanups.push(() => fake.stop(), () => rmSync(dir, { recursive: true, force: true }));
  const state = openStateFile(join(dir, 'state.json'));
  const cpa = createCpa({ baseUrl: fake.url, envPath: '/dev/null', readKey: () => Secret.from(KEY), state, now: realClock.now });
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock: realClock, state, gapMs: 0, claimTimeoutMs: 200 });
  const observer = createObserver({ cpa, now: realClock.now });
  await observer.refresh();
  const poller = createPoller({ anthropic, accounts: observer.accounts, linkOk: () => true, clock: realClock, staggerMs: 0 });
  poller.tick();
  for (let i = 0; i < 100 && !poller.profile(ACC3); i++) await Bun.sleep(10);
  const claims = createClaims({ anthropic, cpa, poller, clock: realClock, followupGapMs: 10 });
  fake.claimDelayMs = 1_000;
  /** The offer the card draws, from the same snapshot the UI gets. */
  const offer = (program: ProgramId) => {
    const now = realClock.now();
    const deck = deriveDeck(snapshot({ accounts: observer.accounts(), feeds: poller.feeds(), claims: claims.list(), now }), now);
    return deck.accounts.find((a) => a.id === ACC3)!.offers.find((o) => o.program === program)!.state;
  };
  const sends = () => fake.mutations.filter((m) => m.path.endsWith('/reset_rate_limits'));
  const usageReads = () => fake.calls.filter((c) => c.path.startsWith('/api/oauth/usage')).length;
  return { fake, claims, poller, offer, sends, usageReads };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'sent';
  } catch (e) {
    return e instanceof DeckError ? e.code : String(e);
  }
};

describe('a claim with an unknown outcome holds its program', () => {
  for (const program of ['juniper_tide', 'cedar_ember'] as const) {
    test(`${program}: the confirming read races the landing, and a second claim is refused without a read or a POST`, async () => {
      const r = await rig();
      const first = await r.claims.claim({ account: ACC3, program });
      expect(first.state.kind).toBe('unknown');
      await Bun.sleep(300);

      expect(r.offer(program).kind).toBe('in_flight');
      const reads = r.usageReads();
      expect(await refusal(r.claims.claim({ account: ACC3, program }))).toBe('not_claimable');
      expect(r.usageReads()).toBe(reads);

      await Bun.sleep(1_200);
      expect(r.sends()).toHaveLength(1);
    });

    test(`${program}: a read newer than the claim, taken before Anthropic applied it, does not release the hold`, async () => {
      const r = await rig();
      const first = await r.claims.claim({ account: ACC3, program });
      expect(first.state.kind).toBe('unknown');

      const newer = await r.poller.readWall(ACC3);
      expect(newer.ok && newer.at > (first.state as { at: number }).at).toBe(true);
      expect(r.offer(program).kind).toBe('in_flight');
      expect(await refusal(r.claims.claim({ account: ACC3, program }))).toBe('not_claimable');

      await Bun.sleep(1_200);
      expect(r.sends()).toHaveLength(1);
    });
  }
});
