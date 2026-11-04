import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic } from '../src/server/anthropic';
import type { Cpa, UpstreamRequest, UpstreamResult } from '../src/server/cpa';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import type { AccountId, CpaAccount, LinkState } from '../src/shared/domain';
import { ACC1, ACC2, ACC3, FakeClock, FIXTURES, MIN, T0, cpaAccounts } from './support';

const N: Record<string, number> = { [ACC2]: 1, [ACC1]: 2, [ACC3]: 3 };
const body = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const ok = (b: string): UpstreamResult => ({ kind: 'answered', status: 200, headers: {}, body: b });
const limited = (retryAfter?: number): UpstreamResult => ({
  kind: 'answered',
  status: 429,
  headers: retryAfter ? { 'retry-after': String(retryAfter) } : {},
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }),
});

function fixtureAnswer(req: UpstreamRequest): UpstreamResult {
  const n = N[req.account];
  const path = new URL(req.url).pathname + new URL(req.url).search;
  if (path.startsWith('/api/oauth/profile')) return ok(body(`anthropic-profile-${n}.json`));
  if (path.includes('at_wall=1')) return ok(body(`anthropic-usage-at-wall-${n}.json`));
  return ok(body(`anthropic-usage-${n}.json`));
}

interface Sent {
  readonly at: number;
  readonly account: AccountId;
  readonly path: string;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cpa-deck-poller-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rig(opts: { accounts?: readonly CpaAccount[]; answer?: (req: UpstreamRequest) => UpstreamResult; link?: () => LinkState; clock?: FakeClock } = {}) {
  const clock = opts.clock ?? new FakeClock(T0);
  const sent: Sent[] = [];
  let answer = opts.answer ?? fixtureAnswer;
  const cpa = {
    link: opts.link ?? (() => ({ kind: 'ok' })),
    apiCall: async (req: UpstreamRequest) => {
      const u = new URL(req.url);
      sent.push({ at: clock.now(), account: req.account, path: u.pathname + u.search });
      return answer(req);
    },
  } as unknown as Cpa;
  const state = openStateFile(join(dir, 'state.json'));
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock, state });
  const accounts = opts.accounts ?? cpaAccounts();
  const poller = createPoller({ anthropic, accounts: () => accounts, linkOk: () => cpa.link().kind === 'ok', clock });
  const run = async (ms: number, step = 1_000) => {
    for (let t = 0; t < ms; t += step) {
      poller.tick();
      await clock.advance(step);
    }
  };
  return { clock, sent, poller, anthropic, state, run, setAnswer: (f: typeof answer) => (answer = f) };
}

const reads = (sent: readonly Sent[], account?: AccountId) => sent.filter((s) => s.path.startsWith('/api/oauth/usage') && (!account || s.account === account));
const gaps = (xs: readonly Sent[]) => xs.slice(1).map((s, i) => s.at - xs[i]!.at);

describe('poll budget', () => {
  test('30 minutes, three accounts: calls 10 s apart, first calls staggered, one read mode per account', async () => {
    const r = rig();
    await r.run(30 * MIN);

    expect(Math.min(...gaps(r.sent))).toBeGreaterThanOrEqual(10_000);
    const order = [ACC2, ACC1, ACC3];
    order.forEach((id, i) => expect(r.sent.find((s) => s.account === id)!.at - T0).toBeGreaterThanOrEqual(i * 15_000));

    expect(new Set(reads(r.sent, ACC3).map((s) => s.path))).toEqual(new Set(['/api/oauth/usage?at_wall=1&skip_spend=1']));
    for (const id of [ACC1, ACC2]) expect(new Set(reads(r.sent, id).map((s) => s.path))).toEqual(new Set(['/api/oauth/usage?cedar_ember=1']));
    for (const g of gaps(reads(r.sent, ACC3))) expect(g).toBeWithin(3 * MIN, 3 * MIN + 30_000);
    for (const g of gaps(reads(r.sent, ACC1))) expect(g).toBeWithin(5 * MIN, 5 * MIN + 30_000);

    for (const id of order) {
      const ts = reads(r.sent, id).map((s) => s.at);
      const worst = Math.max(...ts.map((t) => ts.filter((u) => u >= t && u < t + 15 * MIN).length));
      expect(worst).toBeLessThanOrEqual(id === ACC3 ? 5 : 3);
    }
    expect(r.sent.filter((s) => s.path === '/api/oauth/profile')).toHaveLength(3);
  });

  test('profile is read at start and not again until 6 hours later', async () => {
    const r = rig({ accounts: [cpaAccounts().find((a) => a.id === ACC1)!] });
    await r.run(6 * 60 * MIN + 2 * MIN, 10_000);
    const profiles = r.sent.filter((s) => s.path === '/api/oauth/profile').map((s) => s.at - T0);
    expect(profiles).toHaveLength(2);
    expect(profiles[1]! - profiles[0]!).toBeWithin(6 * 60 * MIN, 6 * 60 * MIN + 30_000);
  });

  test('a 429 backs off that account only: 5, 10, 20, then 30 min, capped; success resets it', async () => {
    const r = rig({ answer: (req) => (req.account === ACC1 && req.url.includes('/usage') ? limited() : fixtureAnswer(req)) });
    await r.run(100 * MIN, 5_000);
    const g = gaps(reads(r.sent, ACC1)).map((x) => Math.round(x / MIN));
    expect(g.slice(0, 5)).toEqual([5, 10, 20, 30, 30]);
    for (const x of gaps(reads(r.sent, ACC2))) expect(x).toBeLessThan(5 * MIN + 30_000);
    const until = r.anthropic.budget(ACC1).backoffUntil!;
    expect(until).toBeGreaterThan(r.clock.now());
    expect(r.poller.feeds()[ACC1]!.limits.nextAt).toBe(until as never);
    expect(r.poller.feeds()[ACC1]!.gate.backoffUntil).toBe(until as never);

    r.setAnswer(fixtureAnswer);
    const before = reads(r.sent, ACC1).length;
    await r.run(45 * MIN, 5_000);
    const after = reads(r.sent, ACC1).slice(before - 1);
    expect(gaps(after).slice(1).every((x) => x < 5 * MIN + 30_000)).toBe(true);
    expect(r.anthropic.budget(ACC1).backoffUntil).toBeNull();
  });

  test('retry-after wins over the ladder when present', async () => {
    const r = rig({ accounts: [cpaAccounts().find((a) => a.id === ACC1)!], answer: (req) => (req.url.includes('/usage') ? limited(900) : fixtureAnswer(req)) });
    await r.run(20 * MIN, 5_000);
    expect(gaps(reads(r.sent)).map((x) => Math.round(x / MIN))).toEqual([15]);
  });

  test('backoff survives a restart: the new process waits for it before any call', async () => {
    const one = [cpaAccounts().find((a) => a.id === ACC1)!];
    const first = rig({ accounts: one, answer: (req) => (req.url.includes('/usage') ? limited() : fixtureAnswer(req)) });
    await first.run(30_000);
    const until = first.anthropic.budget(ACC1).backoffUntil!;
    expect(until).toBeGreaterThan(first.clock.now());

    const second = rig({ accounts: one, clock: new FakeClock(first.clock.now()) });
    await second.run(10 * MIN);
    expect(second.sent.length).toBeGreaterThan(0);
    expect(Math.min(...second.sent.map((s) => s.at))).toBeGreaterThanOrEqual(until);
  });

  test('link down: nothing is sent at all', async () => {
    const r = rig({ link: () => ({ kind: 'rejected', at: T0, envPath: '/x' }) });
    await r.run(10 * MIN, 5_000);
    expect(r.sent).toHaveLength(0);
  });
});

describe('manual refresh', () => {
  test('moves the next read to now, once per 60 s, never during a read or backoff', async () => {
    const one = [cpaAccounts().find((a) => a.id === ACC1)!];
    const r = rig({ accounts: one });
    await r.run(40_000);
    expect(reads(r.sent)).toHaveLength(1);

    expect(r.poller.kick(ACC1)).toEqual([{ account: ACC1, held: null }]);
    expect(r.poller.kick(ACC1)).toEqual([{ account: ACC1, held: 'reading' }]);
    await r.run(15_000);
    expect(reads(r.sent)).toHaveLength(2);
    expect(r.poller.kick(ACC1)).toEqual([{ account: ACC1, held: 'debounced' }]);
    expect(r.poller.feeds()[ACC1]!.gate.manualAt).toBe((T0 + 40_000) as never);

    await r.run(50_000);
    r.setAnswer((req) => (req.url.includes('/usage') ? limited() : fixtureAnswer(req)));
    expect(r.poller.kick(ACC1)).toEqual([{ account: ACC1, held: null }]);
    await r.run(15_000);
    expect(r.anthropic.budget(ACC1).backoffUntil).not.toBeNull();
    await r.run(60_000);
    expect(r.poller.kick('all')).toEqual([{ account: ACC1, held: 'rate_limited' }]);
    await r.run(60_000);
    expect(reads(r.sent)).toHaveLength(3);
  });

  test('after a claim, the next read is a wall read even for an account no longer at the wall', async () => {
    const one = [cpaAccounts().find((a) => a.id === ACC1)!];
    const r = rig({ accounts: one });
    await r.run(40_000);
    expect(reads(r.sent).map((s) => s.path)).toEqual(['/api/oauth/usage?cedar_ember=1']);
    r.poller.wantWall(ACC1, r.clock.now());
    await r.run(15_000);
    expect(reads(r.sent).map((s) => s.path)).toEqual(['/api/oauth/usage?cedar_ember=1', '/api/oauth/usage?at_wall=1&skip_spend=1']);
    await r.run(5 * MIN + 15_000);
    expect(reads(r.sent).at(-1)!.path).toBe('/api/oauth/usage?cedar_ember=1');
  });
});
