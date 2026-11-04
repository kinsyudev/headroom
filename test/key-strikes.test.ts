import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic, realClock } from '../src/server/anthropic';
import { createClaims } from '../src/server/claims';
import { Secret } from '../src/server/config';
import { createCpa } from '../src/server/cpa';
import { handlers } from '../src/server/handlers';
import { createOAuthFlows } from '../src/server/oauth';
import { createObserver } from '../src/server/observer';
import { createPoller } from '../src/server/poller';
import { openStateFile, type StateFile } from '../src/server/state';
import { startFakeCpa, type FakeCpa } from './fake-cpa';
import { ACC1, ACC2 } from './support';

const GOOD = 'good-key';
const AUTH_MS = 40;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fakeCpa(): FakeCpa {
  const fake = startFakeCpa({ key: GOOD });
  fake.authDelayMs = AUTH_MS;
  cleanups.push(() => fake.stop());
  return fake;
}

function stateFile(): StateFile {
  const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-strikes-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return openStateFile(join(dir, 'state.json'));
}

function deck(fake: FakeCpa, state: StateFile, env: { key: string }) {
  const cpa = createCpa({ baseUrl: fake.url, envPath: '/dev/null', readKey: () => Secret.from(env.key), state, now: realClock.now });
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock: realClock, state, gapMs: 0 });
  const observer = createObserver({ cpa, now: realClock.now });
  const poller = createPoller({ anthropic, accounts: observer.accounts, linkOk: () => cpa.link().kind === 'ok', clock: realClock, staggerMs: 0 });
  const claims = createClaims({ anthropic, cpa, poller, clock: realClock });
  const ctx = { cpa, observer, poller, claims, oauth: createOAuthFlows({ cpa, observer, now: realClock.now }) };
  const start = () => {
    observer.start();
    poller.start();
  };
  cleanups.push(() => poller.stop(), () => observer.stop());
  return { cpa, observer, poller, ctx, start };
}

const settled = (ps: readonly Promise<unknown>[]) => Promise.all(ps.map((p) => p.catch((e: unknown) => e)));

describe('management key strikes', () => {
  test('startup with a wrong key strikes once, and nothing else leaves with that key', async () => {
    const fake = fakeCpa();
    const d = deck(fake, stateFile(), { key: 'wrong-key' });
    d.start();
    await settled([d.cpa.clearCooldown(ACC1), d.cpa.getStrategy(), d.observer.refresh()]);
    await Bun.sleep(1_500);
    expect(fake.strikes).toEqual(['wrong-key']);
    expect(d.cpa.link().kind).toBe('rejected');
  });

  test('startup with the right key: the requests that waited on the first one all proceed', async () => {
    const fake = fakeCpa();
    const d = deck(fake, stateFile(), { key: GOOD });
    const [accounts, strategy] = await Promise.all([d.cpa.listAccounts(), d.cpa.getStrategy(), d.cpa.clearCooldown(ACC1)]);
    expect(fake.strikes).toEqual([]);
    expect(accounts.accounts).toHaveLength(3);
    expect(strategy).toBe('fill-first');
    expect(fake.mutations).toEqual([{ method: 'POST', path: '/reset-quota', body: { auth_index: ACC1 } }]);
  });

  test('a restart loop costs one strike per distinct key, and a key CPA already refused is never retried', async () => {
    const fake = fakeCpa();
    const state = stateFile();
    for (const key of ['typo-1', 'typo-1', 'typo-1', 'typo-2', 'typo-1', 'typo-3']) {
      const d = deck(fake, state, { key });
      d.start();
      await settled([d.observer.refresh()]);
      await Bun.sleep(300);
      d.poller.stop();
      d.observer.stop();
    }
    expect(fake.strikes).toEqual(['typo-1', 'typo-2', 'typo-3']);
  });

  test('CPA changing its key under a running deck costs one strike, then one per key the operator tries', async () => {
    const fake = fakeCpa();
    const env = { key: GOOD };
    const d = deck(fake, stateFile(), env);
    d.start();
    for (let i = 0; i < 200 && !d.poller.profile(ACC1); i++) await Bun.sleep(10);
    expect(fake.strikes).toEqual([]);

    fake.key = 'rotated-key';
    await settled([
      d.observer.refresh(),
      d.poller.readWall(ACC1),
      handlers['account.setPriority']({ account: ACC1, priority: 60 }, d.ctx),
      handlers['account.setDisabled']({ account: ACC2, disabled: true }, d.ctx),
    ]);
    await Bun.sleep(1_200);
    expect(fake.strikes).toEqual([GOOD]);
    expect(d.cpa.link().kind).toBe('rejected');

    env.key = 'rotated-typo';
    await settled([d.observer.refresh(), handlers['account.setPriority']({ account: ACC1, priority: 70 }, d.ctx)]);
    await Bun.sleep(1_200);
    expect(fake.strikes).toEqual([GOOD, 'rotated-typo']);

    env.key = 'rotated-key';
    await d.observer.refresh();
    expect(d.cpa.link().kind).toBe('ok');
    expect(d.observer.cpa().error).toBeNull();
    expect(fake.strikes).toEqual([GOOD, 'rotated-typo']);
  });
});
