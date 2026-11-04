import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '../src/server/anthropic';
import { createClaims } from '../src/server/claims';
import type { Cpa, UpstreamRequest, UpstreamResult } from '../src/server/cpa';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import { deriveDeck } from '../src/shared/derive';
import type { AccountId, CpaAccount, Instant } from '../src/shared/domain';
import { DeckError } from '../src/shared/errors';
import { ACC1, ACC2, ACC3, FakeClock, FIXTURES, MIN, T0, cpaAccounts, snapshot } from './support';

const CAP = 8;
const N: Record<string, number> = { [ACC2]: 1, [ACC1]: 2, [ACC3]: 3 };
const body = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const ok = (b: string): UpstreamResult => ({ kind: 'answered', status: 200, headers: {}, body: b });

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Sent {
  readonly at: number;
  readonly account: AccountId;
  readonly path: string;
}

function stubCpa(clock: FakeClock, sent: Sent[]): Cpa {
  return {
    link: () => ({ kind: 'ok' }),
    clearCooldown: async () => undefined,
    apiCall: async (req: UpstreamRequest): Promise<UpstreamResult> => {
      const u = new URL(req.url);
      sent.push({ at: clock.now(), account: req.account, path: u.pathname + u.search });
      const n = N[req.account];
      if (u.pathname === '/api/oauth/profile') return ok(body(`anthropic-profile-${n}.json`));
      if (u.pathname.endsWith('/reset_rate_limits')) return ok(JSON.stringify({ result: 'reset', next_available_at: null, weekly_resets_at: null }));
      if (u.search.includes('at_wall=1')) return ok(body(n === 3 ? 'synthetic-usage-at-wall-claimable.json' : `anthropic-usage-at-wall-${n}.json`));
      return ok(body(`anthropic-usage-${n}.json`));
    },
  } as unknown as Cpa;
}

function rig(opts: { readonly accounts?: readonly CpaAccount[]; readonly clock?: FakeClock; readonly dir?: string; readonly sent?: Sent[] } = {}) {
  const clock = opts.clock ?? new FakeClock(T0);
  const sent = opts.sent ?? [];
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'cpa-deck-cap-'));
  if (!opts.dir) dirs.push(dir);
  const cpa = stubCpa(clock, sent);
  const state = openStateFile(join(dir, 'state.json'));
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock, state });
  const accounts = opts.accounts ?? cpaAccounts();
  const poller = createPoller({ anthropic, accounts: () => accounts, linkOk: () => true, clock });
  const claims = createClaims({ anthropic, cpa, poller, clock });
  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 1_000) {
      poller.tick();
      await clock.advance(1_000);
    }
  };
  const reads = (id: AccountId) => sent.filter((s) => s.account === id && s.path.startsWith('/api/oauth/usage')).map((s) => s.at);
  const worst15 = (id: AccountId) => Math.max(0, ...reads(id).map((t) => reads(id).filter((u) => u >= t && u < t + 15 * MIN).length));
  const nextAllowed = (id: AccountId) => (reads(id).at(-CAP)! + 15 * MIN) as Instant;
  const view = (id: AccountId) => deriveDeck(snapshot({ accounts, feeds: poller.feeds(), claims: claims.list(), now: clock.now() }), clock.now()).accounts.find((a) => a.id === id)!;
  return { clock, sent, dir, poller, claims, run, reads, worst15, nextAllowed, view };
}

const only = (id: AccountId) => cpaAccounts().filter((a) => a.id === id);

describe('read cap', () => {
  test('Read now once a minute for 15 minutes leaves at most 8 usage reads in any 15 minutes', async () => {
    const r = rig({ accounts: only(ACC1) });
    await r.run(30_000);
    for (let i = 0; i < 15; i++) {
      r.poller.kick(ACC1);
      await r.run(60_000);
    }
    expect(r.reads(ACC1).length).toBeGreaterThanOrEqual(CAP);
    expect(r.worst15(ACC1)).toBe(CAP);
  });

  test('Read all once a minute for 20 minutes: at most 8 per account in any 15 minutes, and the refused kicks say capped', async () => {
    const r = rig();
    await r.run(60_000);
    const held: (string | null)[] = [];
    for (let i = 0; i < 20; i++) {
      for (const k of r.poller.kick('all')) held.push(k.held);
      await r.run(60_000);
    }
    for (const id of [ACC2, ACC1, ACC3]) expect(r.worst15(id), id).toBeLessThanOrEqual(CAP);
    expect(held).toContain('capped');
  });

  test("a claim's fresh reads count too: 12 of them 10 s apart leave at most 8 reads in 15 minutes", async () => {
    const r = rig({ accounts: only(ACC1) });
    await r.run(60_000);
    for (let i = 0; i < 12; i++) {
      void r.poller.readWall(ACC1);
      await r.run(10_000);
    }
    expect(r.worst15(ACC1)).toBe(CAP);
  });

  test('while the cap holds, the card says when the next read is allowed', async () => {
    const r = rig({ accounts: only(ACC1) });
    await r.run(30_000);
    for (let i = 0; i < CAP; i++) {
      r.poller.kick(ACC1);
      await r.run(60_000);
    }
    const until = r.nextAllowed(ACC1);
    expect(until).toBeGreaterThan(r.clock.now());
    expect(r.poller.kick(ACC1)).toEqual([{ account: ACC1, held: 'capped' }]);
    expect(r.view(ACC1).read).toMatchObject({ nextAt: until, refreshHeld: { why: 'capped', until } });

    await r.run(until - r.clock.now() + 15_000);
    expect(r.reads(ACC1).at(-1)!).toBeGreaterThanOrEqual(until);
    expect(r.view(ACC1).read.capUntil).toBe(r.nextAllowed(ACC1));
    expect(r.nextAllowed(ACC1)).toBeGreaterThan(until);
  });

  test('a claim while the cap holds is refused with the time the next read is allowed, and sends nothing', async () => {
    const r = rig({ accounts: only(ACC3) });
    await r.run(30_000);
    while (r.reads(ACC3).length < CAP) {
      void r.poller.readWall(ACC3);
      await r.run(10_000);
    }
    const until = r.nextAllowed(ACC3);
    const before = r.sent.length;
    const outcome = r.claims.claim({ account: ACC3, program: 'juniper_tide' }).catch((e: unknown) => e);
    await r.run(20_000);
    const e = await outcome;
    expect(e).toBeInstanceOf(DeckError);
    expect((e as DeckError).code).toBe('not_claimable');
    expect((e as DeckError).message).toContain(new Date(until).toISOString());
    expect(r.sent.slice(before)).toEqual([]);
  });

  test('the cap survives a restart: the next process waits for the window too', async () => {
    const first = rig({ accounts: only(ACC1) });
    await first.run(30_000);
    for (let i = 0; i < CAP; i++) {
      first.poller.kick(ACC1);
      await first.run(60_000);
    }
    first.poller.stop();
    const until = first.nextAllowed(ACC1);
    const count = first.reads(ACC1).length;

    const second = rig({ accounts: only(ACC1), clock: first.clock, dir: first.dir, sent: first.sent });
    await second.run(60_000);
    second.poller.kick(ACC1);
    await second.run(until - second.clock.now() + 15_000);
    const later = second.reads(ACC1).slice(count);
    expect(later.length).toBeGreaterThan(0);
    expect(Math.min(...later)).toBeGreaterThanOrEqual(until);
  });
});
