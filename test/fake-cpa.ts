/**
 * A stand-in for CPA's management API, built from the sanitized fixtures with every timestamp
 * shifted so the fixture's observed_at becomes "now". It mutates its own state the way CPA would
 * and records every mutation it receives, so tests and scripts/e2e.ts can assert exactly what the
 * deck sent. Account 3's wall read is the synthetic claimable body.
 *
 *   bun test/fake-cpa.ts            FAKE_CPA_PORT (default 18317), FAKE_CPA_KEY (default fake-key)
 *   GET /__fake/mutations           what the deck changed, in order
 *   GET /__fake/calls               every api-call (Anthropic) request, for budget checks
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, 'fixtures');
const FIXTURE_OBSERVED_AT = Date.parse('2026-11-04T12:26:12.507Z');
const WEEK = 7 * 86_400_000;
const TEN_MIN = 600_000;

export interface Mutation {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export interface ApiCall {
  readonly at: number;
  readonly account: string;
  readonly method: string;
  readonly path: string;
  readonly userAgent: string;
  readonly xApp: string;
}

export interface FakeCpa {
  readonly url: string;
  readonly mutations: Mutation[];
  readonly calls: ApiCall[];
  /** Accounts whose usage reads answer 429 rate_limit_error. */
  readonly rateLimited: Set<string>;
  claimDelayMs: number;
  /** Fail this many upcoming reset-quota calls with HTTP 500. */
  failResetQuota: number;
  /** The management key CPA accepts. Assigning it models CPA reloading a new key under a running deck. */
  key: string;
  /** How long the key check takes before CPA answers; the real one compares a bcrypt hash. */
  authDelayMs: number;
  /** The bearer each failed authentication carried, in order. CPA bans the IP after 5 in 30 min. */
  readonly strikes: string[];
  stop(): void;
}

type Json = Record<string, any>;

const read = (name: string): Json => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Moves every RFC3339 string and every `*-Reset` epoch header by `delta` ms. */
function shift<T>(value: T, delta: number, key = ''): T {
  if (typeof value === 'string') {
    if (ISO.test(value)) return new Date(Date.parse(value.replace(/(\.\d{3})\d+/, '$1')) + delta).toISOString() as T;
    if (key.endsWith('-Reset') && /^\d+$/.test(value)) return String(Math.round(Number(value) + delta / 1000)) as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => shift(v, delta)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v, delta, k)])) as T;
  }
  return value;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function startFakeCpa(opts: { readonly key: string; readonly port?: number }): FakeCpa {
  const delta = Date.now() - FIXTURE_OBSERVED_AT;
  const ids = [1, 2, 3].map((n) => readFileSync(join(FIXTURES, `auth-index-${n}.txt`), 'utf8').trim());
  const files: Json[] = shift(read('cpa-auth-files.json'), delta).files;
  let strategy = read('cpa-routing-strategy.json').strategy as string;
  const usage = new Map<string, Json>();
  const wall = new Map<string, Json>();
  const profile = new Map<string, Json>();
  ids.forEach((id, i) => {
    const n = i + 1;
    usage.set(id, shift(read(`anthropic-usage-${n}.json`), delta));
    wall.set(id, shift(read(n === 3 ? 'synthetic-usage-at-wall-claimable.json' : `anthropic-usage-at-wall-${n}.json`), delta));
    profile.set(id, read(`anthropic-profile-${n}.json`));
  });
  const oauthPolls = new Map<string, number>();
  let oauthSeq = 0;

  const fake: FakeCpa = {
    url: '',
    mutations: [],
    calls: [],
    rateLimited: new Set(),
    claimDelayMs: 0,
    failResetQuota: 0,
    key: opts.key,
    authDelayMs: 0,
    strikes: [],
    stop: () => server.stop(true),
  };

  const ok = (body: unknown, status = 200) => Response.json(body, { status });
  const byName = (name: unknown) => files.find((f) => f.name === name);

  function authFilesBody(): Json {
    const now = Date.now();
    const last = Math.floor(now / TEN_MIN) * TEN_MIN;
    return {
      observed_at: new Date(now).toISOString(),
      files: files.map((f) => ({
        ...f,
        recent_requests: (f.recent_requests as Json[]).map((b, i, all) => {
          const start = last - (all.length - 1 - i) * TEN_MIN;
          return { ...b, time: `${hhmm(start)}-${hhmm(start + TEN_MIN)}` };
        }),
      })),
    };
  }

  /** After a reset the session window is clear, so the account is no longer at its limit. */
  function clearSession(id: string): void {
    for (const body of [usage.get(id)!, wall.get(id)!]) {
      for (const l of body.limits as Json[]) if (l.kind === 'session') Object.assign(l, { percent: 0, severity: 'normal', is_active: false });
      if (body.five_hour) body.five_hour.utilization = 0;
      if (body.cedar_ember) {
        body.cedar_ember.at_limit = false;
        for (const g of body.cedar_ember.grants as Json[]) g.usable_now = false;
      }
    }
  }

  function claim(id: string, req: Json): Json {
    const w = wall.get(id)!;
    if (req.program === 'juniper_tide') {
      const j = w.juniper_tide;
      if (!j?.eligible || j.arm !== 'reset') return { result: 'ineligible', next_available_at: null, weekly_resets_at: null };
      if (!j.available) return { result: 'already_used', next_available_at: j.next_available_at, weekly_resets_at: j.weekly_resets_at };
      j.available = false;
      j.next_available_at = new Date(Date.now() + WEEK).toISOString();
      clearSession(id);
      return { result: 'reset', next_available_at: j.next_available_at, weekly_resets_at: j.weekly_resets_at };
    }
    const c = w.cedar_ember;
    const g = (c?.grants as Json[] | undefined)?.find((x) => x.id === req.grant_id);
    if (!c?.eligible || !g || g.resets_left <= 0 || !g.usable_now) return { result: 'unavailable', reason: 'not usable', resets_left: g?.resets_left ?? null };
    g.resets_left -= 1;
    clearSession(id);
    return { result: 'reset', reason: null, resets_left: g.resets_left, cleared: g.clears, weekly_resets_at: c.weekly_resets_at, cooldown_until: null };
  }

  async function apiCall(body: Json): Promise<Response> {
    const id = body.auth_index as string;
    const u = new URL(body.url as string);
    const header = (body.header ?? {}) as Record<string, string>;
    fake.calls.push({ at: Date.now(), account: id, method: body.method, path: u.pathname + u.search, userAgent: header['User-Agent'] ?? '', xApp: header['x-app'] ?? '' });
    const envelope = (status: number, payload: unknown, extra: Record<string, string[]> = {}) =>
      ok({ status_code: status, header: { 'Content-Type': ['application/json'], ...extra }, body: JSON.stringify(payload) });
    if (!usage.has(id)) return ok({ error: 'unknown auth_index' }, 400);

    if (u.pathname === '/api/oauth/usage') {
      if (fake.rateLimited.has(id)) {
        return envelope(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } });
      }
      if (u.searchParams.get('at_wall') === '1') {
        const { spend: _spend, ...rest } = wall.get(id)!;
        return envelope(200, rest);
      }
      return envelope(200, { ...usage.get(id)!, cedar_ember: wall.get(id)!.cedar_ember, juniper_tide: null });
    }
    if (u.pathname === '/api/oauth/profile') return envelope(200, profile.get(id));
    if (/^\/api\/organizations\/[^/]+\/reset_rate_limits$/.test(u.pathname) && body.method === 'POST') {
      const req = JSON.parse(body.data as string) as Json;
      fake.mutations.push({ method: 'POST', path: `api-call ${u.pathname}`, body: { auth_index: id, ...req } });
      if (fake.claimDelayMs > 0) await Bun.sleep(fake.claimDelayMs);
      return envelope(200, claim(id, req));
    }
    return envelope(404, { type: 'error', error: { type: 'not_found_error', message: u.pathname } });
  }

  async function management(req: Request, path: string): Promise<Response> {
    if (fake.authDelayMs > 0) await Bun.sleep(fake.authDelayMs);
    const bearer = req.headers.get('authorization') ?? '';
    if (bearer !== `Bearer ${fake.key}`) {
      fake.strikes.push(bearer.replace(/^Bearer /, ''));
      return ok({ error: 'invalid management key' }, 401);
    }
    const url = new URL(req.url);
    const body = (req.method === 'GET' ? {} : await req.json().catch(() => ({}))) as Json;
    const record = () => fake.mutations.push({ method: req.method, path, body });

    if (req.method === 'POST' && path === '/api-call') return apiCall(body);
    if (req.method === 'GET' && path === '/auth-files') return ok(authFilesBody());
    if (req.method === 'GET' && path === '/routing/strategy') return ok({ strategy });
    if (req.method === 'PUT' && path === '/routing/strategy') {
      record();
      strategy = body.value;
      return ok({ status: 'ok' });
    }
    if (req.method === 'PATCH' && path === '/auth-files/status') {
      record();
      const f = byName(body.name);
      if (!f) return ok({ error: 'not found' }, 404);
      f.disabled = body.disabled === true;
      return ok({ status: 'ok', disabled: f.disabled });
    }
    if (req.method === 'PATCH' && path === '/auth-files/fields') {
      record();
      const f = byName(body.name);
      if (!f) return ok({ error: 'not found' }, 404);
      if (typeof body.priority === 'number') f.priority = body.priority;
      return ok({ status: 'ok' });
    }
    if (req.method === 'POST' && path === '/reset-quota') {
      record();
      if (fake.failResetQuota > 0) {
        fake.failResetQuota -= 1;
        return ok({ error: 'scheduler busy' }, 500);
      }
      const f = files.find((x) => x.auth_index === body.auth_index);
      if (!f) return ok({ error: 'not found' }, 404);
      Object.assign(f, { cooldowns: [], unavailable: false, status: 'active', status_message: '' });
      delete f.next_retry_after;
      return ok({ status: 'ok', auth_index: f.auth_index, models: [] });
    }
    if (req.method === 'POST' && path === '/auth-files/refresh') {
      record();
      const f = byName(body.name);
      if (!f) return ok({ error: 'not found' }, 404);
      f.last_refresh = new Date().toISOString();
      return ok({ ok: true, auth: { access_token: 'sk-ant-oat01-FAKE-ACCESS', refresh_token: 'sk-ant-ort01-FAKE-REFRESH', expires_in: 28800 } });
    }
    if (req.method === 'GET' && path === '/anthropic-auth-url') {
      const state = `fake-state-${++oauthSeq}`;
      oauthPolls.set(state, 0);
      return ok({ status: 'ok', url: `${fake.url}/__fake/oauth/authorize?state=${state}`, state });
    }
    if (req.method === 'GET' && path === '/get-auth-status') {
      const state = url.searchParams.get('state') ?? '';
      const polls = (oauthPolls.get(state) ?? 0) + 1;
      oauthPolls.set(state, polls);
      if (polls < 3) return ok({ status: 'wait' });
      if (!files.some((f) => f.email === 'account4@example.com')) {
        files.push({
          ...structuredClone(files[1]),
          auth_index: 'a4a4a4a4a4a4a4a4',
          name: 'claude-fake-account4@example.com.json',
          email: 'account4@example.com',
          priority: 0,
          quota: undefined,
          model_quotas: {},
        });
      }
      return ok({ status: 'ok' });
    }
    return ok({ error: `no fake for ${req.method} ${path}` }, 404);
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/v0/management')) return management(req, path.slice('/v0/management'.length));
      if (path === '/__fake/mutations') return ok(fake.mutations);
      if (path === '/__fake/calls') return ok(fake.calls);
      if (path === '/__fake/oauth/authorize') return new Response('<!doctype html><title>Fake Anthropic sign-in</title><p>Fake Anthropic sign-in. The deck finishes the flow.</p>', { headers: { 'Content-Type': 'text/html' } });
      return ok({ error: 'not found' }, 404);
    },
  });
  (fake as { url: string }).url = `http://127.0.0.1:${server.port}`;
  return fake;
}

if (import.meta.main) {
  const fake = startFakeCpa({ key: process.env.FAKE_CPA_KEY ?? 'fake-key', port: Number(process.env.FAKE_CPA_PORT ?? 18317) });
  console.log(`fake CPA on ${fake.url}`);
}
