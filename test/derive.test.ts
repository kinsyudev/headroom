/**
 * deriveDeck and its parts over the real CPA fixture and the real usage fixtures.
 * now = T0, the CPA fixture's observed_at (2026-11-04T12:26:12.507Z), unless a row says otherwise.
 */
import { describe, expect, test } from 'bun:test';
import {
  cedarState,
  deriveDeck,
  deriveOffers,
  freshness,
  isAtWall,
  juniperState,
  mergeLimits,
  planMakePrimary,
} from '../src/shared/derive';
import {
  emptyFeeds,
  emptySource,
  type CedarEmber,
  type ClaimId,
  type ClaimRecord,
  type CpaAccount,
  type GrantId,
  type Instant,
  type JuniperTide,
  type Limit,
  type Sample,
} from '../src/shared/domain';
import type { OfferState } from '../src/shared/view';
import { ACC1, ACC2, ACC3, MIN, T0, account, at, cpaAccounts, feedsFrom, plus, snapshot, usage } from './support';

const AFTER_COOLDOWN = at('2026-11-04T14:20:18Z');
const pollOf = (name: string, t: Instant): Sample<readonly Limit[]> => ({ value: usage(name, 'normal').limits, at: t });

describe('routing and serving', () => {
  const deck = (s: Parameters<typeof snapshot>[0], now = T0) => deriveDeck(snapshot({ ...s, now }), now);
  const view = (d: ReturnType<typeof deck>, id: string) => d.accounts.find((a) => a.id === id)!;

  test.each([
    // [label, now, account, role, isTarget]
    ['account1: priority 50 and eligible, so the fill-first target and serving', T0, ACC1, { kind: 'serving', why: 'fill_first_target' }, true],
    ['account2: priority 10 but answered 33 s ago, so serving by affinity', T0, ACC2, { kind: 'serving', why: 'affinity' }, false],
    ['account3: credential cooldown, blocked until 14:20:17Z', T0, ACC3, { kind: 'blocked', until: at('2026-11-04T14:20:17.000Z'), reason: 'credential_quota' }, false],
    ['account3 after its cooldown: eligible and back in the top tier though status is still error', AFTER_COOLDOWN, ACC3, { kind: 'standby' }, true],
  ] as const)('%s', (_label, now, id, role, isTarget) => {
    const r = view(deck({}, now), id).routing;
    expect(r.role).toEqual(role as never);
    expect(r.isTarget).toBe(isTarget);
  });

  test('keeper evidence wins over CPA headers when keeper answers', () => {
    const d = deck({ serving: [{ account: ACC1, lastAt: plus(T0, -10_000), recent: 14 }, { account: ACC2, lastAt: plus(T0, -5 * MIN), recent: 0 }] });
    expect(d.overview.servingEvidence).toBe('keeper');
    expect(view(d, ACC1).routing.role).toEqual({ kind: 'serving', why: 'fill_first_target' });
    expect(view(d, ACC1).routing.recent).toBe(14);
    expect(view(d, ACC2).routing.role).toEqual({ kind: 'standby' });
    expect(d.overview.serving.map((s) => s.account)).toEqual([ACC1]);
  });

  test('without keeper, the overview names CPA headers as the evidence and lists both serving accounts newest first', () => {
    const d = deck({});
    expect(d.overview.servingEvidence).toBe('cpa_headers');
    expect(d.overview.serving.map((s) => [s.account, s.why])).toEqual([
      [ACC1, 'fill_first_target'],
      [ACC2, 'affinity'],
    ]);
    expect(d.overview.target?.account).toBe(ACC1);
  });

  test('round-robin: every eligible account is a target and serving accounts say so', () => {
    const d = deck({ strategy: 'round-robin' });
    expect(view(d, ACC2).routing).toMatchObject({ isTarget: true, role: { kind: 'serving', why: 'round_robin' } });
    expect(view(d, ACC3).routing.isTarget).toBe(false);
  });

  test('a disabled account is never a target, and the next eligible tier takes over', () => {
    const accounts = cpaAccounts().map((a): CpaAccount => (a.id === ACC1 ? { ...a, disabled: true } : a));
    const v = view(deck({ accounts }), ACC1);
    expect(v.routing.role).toEqual({ kind: 'disabled' });
    expect(v.routing.isTarget).toBe(false);
    expect(v.can).toMatchObject({ enable: true, disable: false, makePrimary: true });
    // account3 is blocked, so account2 at priority 10 is the only eligible tier left.
    expect(view(deck({ accounts }), ACC2).routing.isTarget).toBe(true);
  });
});

describe('isAtWall', () => {
  const a1 = account(ACC1);
  const a3 = account(ACC3);
  const bare = (a: CpaAccount): CpaAccount => ({ ...a, headers: null, cooldowns: [], unavailable: false });

  test.each([
    ['account1 headers at 17% / 27%, allowed', a1, null, T0, false],
    ['account3: headers rejected and a credential_quota cooldown', a3, null, T0, true],
    ['account3 once the cooldown and the 5h header window have passed', a3, null, AFTER_COOLDOWN, false],
    ['a poll with session at 100%', bare(a3), pollOf('anthropic-usage-3.json', T0), T0, true],
    ['the same poll after its session reset: the window lapsed', bare(a3), pollOf('anthropic-usage-3.json', T0), AFTER_COOLDOWN, false],
    ['a poll at 12% / 27%', bare(a1), pollOf('anthropic-usage-2.json', T0), T0, false],
    ['only a model-scoped quota cooldown', { ...bare(a3), cooldowns: a3.cooldowns.filter((c) => c.model !== null) }, null, T0, false],
    ['a credential cooldown for a non-quota reason', { ...bare(a3), cooldowns: [{ model: null, reason: 'unauthorized', retryAt: plus(T0, MIN), httpStatus: 401 }] }, null, T0, false],
    ['a credential quota cooldown alone', { ...bare(a3), cooldowns: [{ model: null, reason: 'quota', retryAt: plus(T0, MIN), httpStatus: 429 }] }, null, T0, true],
  ] as const)('%s: %p', (_label, a, poll, now, expected) => {
    expect(isAtWall(a, poll, now)).toBe(expected);
  });
});

describe('window lifecycle', () => {
  const rows = (poll: Sample<readonly Limit[]> | null, a: CpaAccount | null, now: Instant) =>
    mergeLimits(poll, a?.headers ?? null, now).map((l): unknown[] => [l.key, l.phase, l.percent, l.source.kind, l.other?.kind ?? null, l.other?.percent ?? null]);

  test('fixture 1 has no session limit: the session row is idle, never 0% or 100%', () => {
    expect(rows(pollOf('anthropic-usage-1.json', T0), null, T0)).toEqual([
      ['session', 'idle', null, 'poll', null, null],
      ['weekly_all', 'open', 1, 'poll', null, null],
      ['weekly_scoped:Fable', 'open', 0, 'poll', null, null],
    ]);
  });

  test('headers only: account1 shows 17% / 27% from headers, with resets from the epoch headers', () => {
    const m = mergeLimits(null, account(ACC1).headers, T0);
    expect(rows(null, account(ACC1), T0)).toEqual([
      ['session', 'open', 17, 'headers', null, null],
      ['weekly_all', 'open', 27, 'headers', null, null],
    ]);
    expect(m[0]!.resetsAt).toBe(at('2026-11-04T17:00:00Z'));
  });

  test('a poll older than the headers: headers drawn, poll kept as the faint tick', () => {
    expect(rows(pollOf('anthropic-usage-2.json', plus(T0, -5 * MIN)), account(ACC1), T0).slice(0, 2)).toEqual([
      ['session', 'open', 17, 'headers', 'poll', 12],
      ['weekly_all', 'open', 27, 'headers', 'poll', 27],
    ]);
  });

  test('a poll newer than the headers: poll drawn, headers kept as the faint tick', () => {
    expect(rows(pollOf('anthropic-usage-2.json', T0), account(ACC1), T0).slice(0, 2)).toEqual([
      ['session', 'open', 12, 'poll', 'headers', 17],
      ['weekly_all', 'open', 27, 'poll', 'headers', 27],
    ]);
  });

  test('after resetsAt with nothing newer, the row is lapsed and the old percent is gone', () => {
    const m = mergeLimits(pollOf('anthropic-usage-3.json', T0), null, AFTER_COOLDOWN);
    expect(m[0]).toMatchObject({ key: 'session', phase: 'lapsed', percent: null, severity: 'normal', resetsAt: at('2026-11-04T14:20:00.412Z') });
    expect(m[1]).toMatchObject({ key: 'weekly_all', phase: 'open', percent: 60 });
  });

  test('a newer header window after a reset replaces the lapsed poll row', () => {
    const fresh: CpaAccount = {
      ...account(ACC3),
      headers: { observedAt: plus(AFTER_COOLDOWN, -MIN), status: 'allowed', resetsAt: null, overageDisabledReason: null, windows: [{ key: '5h', percent: 4 as never, resetsAt: at('2026-11-04T19:20:00Z'), status: 'allowed' }] },
    };
    expect(mergeLimits(pollOf('anthropic-usage-3.json', T0), fresh.headers, AFTER_COOLDOWN)[0]).toMatchObject({ phase: 'open', percent: 4, source: { kind: 'headers' }, other: null });
  });

  test('a rejected header status draws as critical', () => {
    expect(mergeLimits(null, account(ACC3).headers, T0)[0]).toMatchObject({ key: 'session', percent: 100, severity: 'critical' });
  });

  test('a poll without a session limit and older 5h headers stays idle and shows the header value as the tick', () => {
    const m = mergeLimits(pollOf('anthropic-usage-1.json', T0), account(ACC1).headers, T0);
    expect(m[0]).toMatchObject({ key: 'session', phase: 'idle', percent: null, other: { kind: 'headers', percent: 17 } });
  });
});

describe('offers and claimability', () => {
  const j = (over: Partial<JuniperTide>): JuniperTide => ({
    eligible: true, ineligibleReason: null, arm: 'reset', available: true, nextAvailableAt: null, weeklyResetsAt: null, resetsPerWeek: 1, ...over,
  });
  const synthetic = usage('synthetic-usage-at-wall-claimable.json', 'wall');
  const cedar = (synthetic.mode === 'wall' ? synthetic.cedar : null)!;
  const c = (over: Partial<CedarEmber>): CedarEmber => ({ ...cedar, ...over });
  const grant = cedar.grants[0]!;

  test.each([
    ['synthetic fixture: eligible, reset arm, available', synthetic.mode === 'wall' ? synthetic.juniper : null, { kind: 'claimable', grant: null }],
    ['fixture 1: not_at_wall', j({ eligible: false, ineligibleReason: 'not_at_wall', arm: null, available: false }), { kind: 'ineligible', reason: 'not_at_wall' }],
    ['null program', null, { kind: 'not_enrolled' }],
    ['used this week, next one Thursday', j({ available: false, nextAvailableAt: at('2026-11-05T09:00:00Z') }), { kind: 'waiting', until: at('2026-11-05T09:00:00Z') }],
    ['control arm', j({ arm: 'control' }), { kind: 'ineligible', reason: 'control_arm' }],
    ['tenure', j({ eligible: false, ineligibleReason: 'tenure' }), { kind: 'ineligible', reason: 'tenure', explain: 'Account is too new.' }],
  ] as const)('juniper_tide, %s', (_label, value, expected) => {
    expect(juniperState(value as JuniperTide | null)).toMatchObject(expected);
  });

  test.each([
    ['synthetic fixture: next_grant_id usable', cedar, { kind: 'claimable', grant: 'grant_example_1' }],
    ['fixture 1: no_grant', usage('anthropic-usage-at-wall-1.json', 'wall').cedar, { kind: 'ineligible', reason: 'no_grant' }],
    ['null program', null, { kind: 'not_enrolled' }],
    ['every grant used up', c({ grants: [{ ...grant, resetsLeft: 0 }] }), { kind: 'ineligible', reason: 'exhausted' }],
    ['cooldown_until ahead', c({ cooldownUntil: plus(T0, 10 * MIN) }), { kind: 'waiting', until: plus(T0, 10 * MIN) }],
    ['paused grant', c({ grants: [{ ...grant, paused: true }] }), { kind: 'waiting', until: null }],
    ['next_grant_id not usable: the first usable grant', c({ nextGrantId: 'g_paused' as GrantId, grants: [{ ...grant, id: 'g_paused' as GrantId, paused: true }, grant] }), { kind: 'claimable', grant: 'grant_example_1' }],
    ['grant not usable now', c({ grants: [{ ...grant, usableNow: false }] }), { kind: 'ineligible', reason: 'not_usable_now' }],
    ['program not eligible though a grant has resets', c({ eligible: false, ineligibleReason: 'tier' }), { kind: 'ineligible', reason: 'tier' }],
  ] as const)('cedar_ember, %s', (_label, value, expected) => {
    expect(cedarState(value as CedarEmber | null, T0)).toMatchObject(expected);
  });

  const claim = (state: ClaimRecord['state'], program: ClaimRecord['program'] = 'juniper_tide'): ClaimRecord => ({
    id: 'c1' as ClaimId, account: ACC3, program, grant: null, startedAt: T0, state,
  });
  const offers = (feeds = feedsFrom(synthetic, T0), atWall = true, claims: ClaimRecord[] = []) =>
    Object.fromEntries(deriveOffers(ACC3, feeds, atWall, claims, T0).map((o) => [o.program, o.state])) as Record<ClaimRecord['program'], OfferState>;

  test('at the wall with the synthetic read, both programs are claimable', () => {
    expect(offers()).toEqual({ juniper_tide: { kind: 'claimable', grant: null }, cedar_ember: { kind: 'claimable', grant: 'grant_example_1' as GrantId } });
  });

  test('away from the wall juniper is held, remembering that the last read was claimable', () => {
    expect(offers(undefined, false).juniper_tide).toEqual({ kind: 'held', lastAt: T0, lastClaimable: true });
  });

  test('a sending claim holds its program in flight whatever the data says', () => {
    expect(offers(undefined, true, [claim({ kind: 'sending' })]).juniper_tide).toEqual({ kind: 'in_flight', claim: 'c1' as ClaimId, unknown: false });
  });

  test('an unknown outcome stays in flight until a newer read of that program arrives, then the read decides', () => {
    const unknown = claim({ kind: 'unknown', at: plus(T0, MIN), why: 'timed out' });
    expect(offers(feedsFrom(synthetic, T0), true, [unknown]).juniper_tide).toEqual({ kind: 'in_flight', claim: 'c1' as ClaimId, unknown: true });
    const consumed = { ...synthetic, juniper: { ...(synthetic.mode === 'wall' ? synthetic.juniper! : j({})), available: false, nextAvailableAt: at('2026-11-11T09:00:00Z') } };
    expect(offers(feedsFrom(consumed, plus(T0, 2 * MIN)), true, [unknown]).juniper_tide).toEqual({ kind: 'waiting', until: at('2026-11-11T09:00:00Z') });
  });

  test('a settled claim does not hold the program', () => {
    const settled = claim({ kind: 'settled', at: T0, outcome: { result: 'not_sent', why: 'x' }, followup: 'not_needed' });
    expect(offers(undefined, true, [settled]).juniper_tide.kind).toBe('claimable');
  });

  test('never read is unknown/never_read; an error with no data is unknown/failing', () => {
    expect(offers(emptyFeeds(), true).cedar_ember).toEqual({ kind: 'unknown', why: 'never_read' });
    const failing = { ...emptyFeeds(), cedar: { ...emptySource<CedarEmber | null>(), error: { value: { kind: 'rate_limited' as const, retryAt: plus(T0, MIN) }, at: T0 } } };
    expect(offers(failing, true).cedar_ember).toEqual({ kind: 'unknown', why: 'failing' });
  });

  test('the overview lists every claimable offer with the grant label', () => {
    const d = deriveDeck(snapshot({ feeds: { [ACC3]: feedsFrom(synthetic, T0) } }), T0);
    expect(d.overview.claimable).toEqual([
      { account: ACC3, email: 'account3@example.com', program: 'juniper_tide', grant: null, label: 'Weekly session reset' },
      { account: ACC3, email: 'account3@example.com', program: 'cedar_ember', grant: 'grant_example_1' as GrantId, label: 'Reset grant · Session reset' },
    ]);
  });
});

describe('make primary', () => {
  const accounts = cpaAccounts();
  test.each([
    ['account2 at 10 under 50/50 goes to 60', accounts, ACC2, { priority: 60, enable: false }],
    ['account1 tied at 50 with account3 goes to 60', accounts, ACC1, { priority: 60, enable: false }],
    ['an account already strictly highest is a no-op', accounts.map((a) => (a.id === ACC1 ? { ...a, priority: 60 } : a)), ACC1, { priority: null, enable: false }],
    ['a disabled target is enabled too', accounts.map((a) => (a.id === ACC2 ? { ...a, disabled: true } : a)), ACC2, { priority: 60, enable: true }],
  ] as const)('%s', (_label, list, id, expected) => {
    expect(planMakePrimary(list, id)).toEqual(expected);
  });
});

describe('headroom and next reset', () => {
  test('session headroom is min(session left, weekly left); idle sessions count as full', () => {
    const feeds = {
      [ACC1]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
      [ACC2]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
      [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
    };
    const d = deriveDeck(snapshot({ feeds }), T0);
    // account1 min(88, 73) + account2 min(100, 99) + account3 min(0, 40)
    expect(d.overview.headroom.session).toEqual({ value: 1.72, of: 3, unknown: 0 });
    expect(d.overview.headroom.weekly).toEqual({ value: 2.12, of: 3, unknown: 0 });
    expect(d.overview.nextReset).toMatchObject({ account: ACC3, label: 'Session', at: at('2026-11-04T14:20:00.412Z') });
    expect(d.overview.nextUnblock).toEqual({ account: ACC3, email: 'account3@example.com', at: at('2026-11-04T14:20:17.000Z') });
  });

  test('an account with no limits data counts as unknown, not as 0 or 100', () => {
    const noHeaders = cpaAccounts().map((a): CpaAccount => (a.id === ACC2 ? { ...a, headers: null } : a));
    const d = deriveDeck(snapshot({ accounts: noHeaders }), T0);
    expect(d.overview.headroom.weekly.unknown).toBe(1);
    expect(d.overview.headroom.weekly.of).toBe(3);
  });
});

describe('freshness', () => {
  test.each([
    ['4 min old limits are fresh', { last: { value: [], at: plus(T0, -4 * MIN) } }, false, 'fresh'],
    ['8 min old limits are aging', { last: { value: [], at: plus(T0, -8 * MIN) } }, false, 'aging'],
    ['20 min old limits are stale', { last: { value: [], at: plus(T0, -20 * MIN) } }, false, 'stale'],
    ['an error newer than the data is failing, and still reports the data age', { last: { value: [], at: plus(T0, -4 * MIN) }, error: { value: { kind: 'rate_limited', retryAt: plus(T0, 14 * MIN) }, at: plus(T0, -MIN) } }, false, 'failing'],
    ['never read', {}, false, 'never'],
    ['juniper away from the wall is held', { last: { value: [], at: plus(T0, -40 * MIN) } }, true, 'held'],
  ] as const)('%s', (_label, src, held, state) => {
    const f = freshness(held ? 'juniper' : 'limits', { ...emptySource(), ...src } as never, T0, held);
    expect(f.state).toBe(state);
    if (state === 'failing') expect(f).toMatchObject({ ageMs: 4 * MIN, errorAgeMs: MIN, error: { kind: 'rate_limited' } });
  });
});
