import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnthropic, realClock } from '../src/server/anthropic';
import { createClaims } from '../src/server/claims';
import { Secret } from '../src/server/config';
import { createCpa } from '../src/server/cpa';
import { handlers } from '../src/server/handlers';
import { serve } from '../src/server/http';
import { openKeeper } from '../src/server/keeper';
import { createOAuthFlows } from '../src/server/oauth';
import { createObserver } from '../src/server/observer';
import { createPoller } from '../src/server/poller';
import { openStateFile } from '../src/server/state';
import type { Snapshot } from '../src/shared/domain';
import { HORIZON_MS, type UsageCube } from '../src/shared/usage';
import { startFakeCpa, type FakeCpa } from './fake-cpa';
import { createKeeperDb } from './fake-keeper';
import { ACC1, ACC2, ACC3 } from './support';

const KEY = 'k-SECRET-management-key-123';
let fake: FakeCpa;
let base: string;
let port: number;
let dir: string;
let stop: () => Promise<void>;
let snapshot: () => Snapshot;

beforeAll(async () => {
  fake = startFakeCpa({ key: KEY });
  dir = mkdtempSync(join(tmpdir(), 'headroom-http-'));
  createKeeperDb(join(dir, 'app.db'));
  const state = openStateFile(join(dir, 'state.json'));
  const cpa = createCpa({ baseUrl: fake.url, envPath: '/dev/null', readKey: () => Secret.from(KEY), state, now: realClock.now });
  const anthropic = createAnthropic({ cpa, cliVersion: '2.1.311', clock: realClock, state, gapMs: 0 });
  const observer = createObserver({ cpa, now: realClock.now });
  await observer.refresh();
  const poller = createPoller({ anthropic, accounts: observer.accounts, linkOk: () => true, clock: realClock, staggerMs: 0 });
  const keeper = openKeeper(join(dir, 'app.db'), realClock.now);
  await keeper.start();
  const claims = createClaims({ anthropic, cpa, poller, clock: realClock });
  const oauth = createOAuthFlows({ cpa, observer, now: realClock.now });
  snapshot = () => ({
    generatedAt: realClock.now(),
    cpaBaseUrl: 'http://127.0.0.1:8317',
    link: cpa.link(),
    cpa: observer.cpa(),
    strategy: observer.strategy(),
    feeds: poller.feeds(),
    serving: keeper.serving(),
    claims: claims.list(),
    flows: oauth.list(),
  });
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    assets: new Map([['/', { body: new TextEncoder().encode('<!doctype html><div id="root"></div>').buffer as ArrayBuffer, type: 'text/html' }]]),
    snapshot,
    usage: () => keeper.usage(observer.accounts().map((a) => a.id)),
    handlers,
    ctx: { cpa, observer, poller, claims, oauth },
  });
  base = server.url;
  port = Number(new URL(base).port);
  stop = async () => {
    keeper.stop();
    await server.stop();
  };
});

afterAll(async () => {
  await stop();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const act = (kind: string, input: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/act`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Headroom': '1', ...headers },
    body: JSON.stringify({ kind, input }),
  });

describe('guard', () => {
  test.each([
    ['127.0.0.1:<port>', (p: number) => `127.0.0.1:${p}`, 200],
    ['localhost:<port>', (p: number) => `localhost:${p}`, 200],
    ['a rebinding name on the right port', (p: number) => `evil.example:${p}`, 421],
    ['the right address on another port', () => '127.0.0.1:9', 421],
  ])('GET with Host %s', async (_label, host, status) => {
    for (const path of ['/api/snapshot', '/']) {
      expect((await fetch(`${base}${path}`, { headers: { Host: host(port) } })).status).toBe(status);
    }
  });

  test.each([
    ['without X-Headroom', { 'X-Headroom': '' }, 403],
    ['with a form content type', { 'Content-Type': 'text/plain' }, 415],
    ['from another origin', { Origin: 'http://evil.example' }, 403],
    ['from this origin', { Origin: '__self__' }, 200],
    ['with no Origin (curl)', {}, 200],
  ])('POST %s', async (_label, headers, status) => {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v === '__self__' ? base : v]).filter(([, v]) => v !== ''));
    const before = fake.mutations.length;
    const res = await fetch(`${base}/api/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...('X-Headroom' in headers ? {} : { 'X-Headroom': '1' }), ...h },
      body: JSON.stringify({ kind: 'routing.setStrategy', input: { strategy: 'fill-first' } }),
    });
    expect(res.status).toBe(status);
    expect(fake.mutations.length - before).toBe(status === 200 ? 1 : 0);
  });

  test('preflights get no answer and no response carries CORS headers', async () => {
    const pre = await fetch(`${base}/api/act`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.ok).toBe(false);
    for (const res of [pre, await fetch(`${base}/api/snapshot`), await fetch(`${base}/`)]) {
      const keys: string[] = [];
      res.headers.forEach((_v, k) => keys.push(k));
      expect(keys.filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('actions over HTTP', () => {
  test('unknown kinds, bad input and unknown accounts are refused before CPA sees anything', async () => {
    const before = fake.mutations.length;
    expect((await act('account.delete', { account: ACC1 })).status).toBe(400);
    expect((await act('account.setDisabled', { account: 'not-hex', disabled: true })).status).toBe(400);
    expect(await (await act('account.setDisabled', { account: 'abcdefabcdefabcd', disabled: true })).json()).toMatchObject({ error: { code: 'unknown_account' } });
    expect(fake.mutations.length).toBe(before);
  });

  test('make primary is idempotent: the second click writes nothing', async () => {
    const before = fake.mutations.length;
    expect(await (await act('account.makePrimary', { account: ACC2 })).json()).toMatchObject({ priority: 60, changed: true });
    expect(await (await act('account.makePrimary', { account: ACC2 })).json()).toMatchObject({ priority: 60, changed: false });
    expect(fake.mutations.slice(before)).toEqual([{ method: 'PATCH', path: '/auth-files/fields', body: { name: 'claude-793879e9-account2@example.com.json', priority: 60 } }]);
  });

  test('refresh token answers { ok, cpaAt } and no token text reaches the client', async () => {
    const res = await act('account.refreshToken', { account: ACC1 });
    const text = await res.text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['cpaAt', 'ok']);
    expect(text).not.toMatch(/sk-ant|access_token|refresh_token/);
  });

  test('the snapshot never carries the management key or file paths', async () => {
    const text = await (await fetch(`${base}/api/snapshot`)).text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('/home/user');
    expect((JSON.parse(text) as Snapshot).cpa.last?.value).toHaveLength(3);
  });

  test('usage answers the whole horizon with no parameters, current to keeper, without session ids or error bodies', async () => {
    const res = await fetch(`${base}/api/usage`);
    const text = await res.text();
    const cube = JSON.parse(text) as UsageCube;
    expect(res.status).toBe(200);
    expect(cube.catchingUp).toBe(false);
    expect(cube.generatedAt - cube.horizonStart).toBe(HORIZON_MS);
    expect(cube.generatedAt - cube.keeperLatestAt!).toBeLessThan(2 * 60_000);
    expect(new Set(cube.cells.map((c) => c.account))).toEqual(new Set([ACC1, ACC2, ACC3]));
    expect(cube.errors.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(text).not.toContain('"type":"error"');
  });
});
