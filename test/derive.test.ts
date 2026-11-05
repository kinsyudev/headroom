import { describe, expect, test } from 'bun:test';
import {
  cedarState,
  deriveDeck,
  deriveOffers,
  deriveSpend,
  freshness,
  isAtWall,
  juniperState,
  mergeLimits,
  planMakePrimary,
  quietOffers,
} from '../src/shared/derive';
import {
  emptyFeeds,
  emptySource,
  type AccountFeeds,
  type AccountId,
  type CedarEmber,
  type ClaimId,
  type ClaimRecord,
  type Cooldown,
  type CooldownReason,
  type CpaAccount,
  type GrantId,
  type Instant,
  type JuniperTide,
  type Limit,
  type Percent,
  type Sample,
  type Severity,
  type Snapshot,
  type Source,
  type SourceError,
  type Spend,
} from '../src/shared/domain';
import type { OfferState, ServeOrderView } from '../src/shared/view';
import { ACC1, ACC2, ACC3, MIN, T0, account, at, cpaAccounts, feedsFrom, plus, snapshot, usage } from './support';

const AFTER_COOLDOWN = at('2026-11-04T14:20:18Z');
const pollOf = (name: string, t: Instant): Sample<readonly Limit[]> => ({ value: usage(name, 'normal').limits, at: t });

describe('routing and serving', () => {
  const deck = (s: Parameters<typeof snapshot>[0], now = T0) => deriveDeck(snapshot({ ...s, now }), now);
  const view = (d: ReturnType<typeof deck>, id: string) => d.accounts.find((a) => a.id === id)!;

  test.each([
    ['account1: priority 50 and eligible, so the fill-first target and serving', T0, ACC1, { kind: 'serving', why: 'fill_first_target' }, true],
    ['account2: priority 10 but answered 33 s ago, so serving by affinity', T0, ACC2, { kind: 'serving', why: 'affinity' }, false],
    ['account3: credential cooldown, blocked until 14:20:17Z', T0, ACC3, { kind: 'blocked', until: at('2026-11-04T14:20:17.000Z'), reason: 'credential_quota' }, false],
    ['account3 after its cooldown: eligible and back in the top tier though status is still error', AFTER_COOLDOWN, ACC3, { kind: 'standby' }, true],
  ] as const)('%s', (_label, now, id, role, isTarget) => {
    const r = view(deck({}, now), id).routing;
    expect(r.role).toEqual(role as never);
    expect(r.isTarget).toBe(isTarget);
  });

  test.each([
    [0, { down: null, up: 10 }],
    [5, { down: 0, up: 15 }],
    [50, { down: 40, up: 60 }],
    [995, { down: 985, up: 1000 }],
    [1000, { down: 990, up: null }],
  ] as const)('priority %p steps to %p', (priority, stepTo) => {
    const accounts = cpaAccounts().map((a): CpaAccount => (a.id === ACC1 ? { ...a, priority } : a));
    const { routing } = view(deck({ accounts }), ACC1);
    expect(routing.stepTo).toEqual(stepTo);
    expect(routing.step).toBe(10);
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

  test('new sessions go to the predicted target whichever account answered last', () => {
    const seen = (account: typeof ACC1) => deck({ serving: [{ account, lastAt: plus(T0, -10_000), recent: 3 }] }).overview;
    expect([seen(ACC1).serving[0]?.account, seen(ACC1).target?.account]).toEqual([ACC1, ACC1]);
    expect([seen(ACC2).serving[0]?.account, seen(ACC2).target?.account]).toEqual([ACC2, ACC1]);
  });

  test('round-robin: every eligible account is a target and serving accounts say so', () => {
    const d = deck({ strategy: 'round-robin' });
    expect(view(d, ACC2).routing).toMatchObject({ isTarget: true, role: { kind: 'serving', why: 'round_robin' } });
    expect(view(d, ACC3).routing.isTarget).toBe(false);
  });

  test('priority ranks the accounts under fill-first and is ignored under round-robin', () => {
    expect(view(deck({}), ACC1).routing.ranksByPriority).toBe(true);
    expect(view(deck({ strategy: 'round-robin' }), ACC1).routing.ranksByPriority).toBe(false);
  });

  test('a disabled account is never a target, and the next eligible tier takes over', () => {
    const accounts = cpaAccounts().map((a): CpaAccount => (a.id === ACC1 ? { ...a, disabled: true } : a));
    const v = view(deck({ accounts }), ACC1);
    expect(v.routing.role).toEqual({ kind: 'disabled' });
    expect(v.routing.isTarget).toBe(false);
    expect(v.can).toMatchObject({ enable: true, disable: false, makePrimary: true });
    expect(view(deck({ accounts }), ACC2).routing.isTarget).toBe(true);
  });

  const blockedOnTop = cpaAccounts().map((a): CpaAccount => (a.id === ACC3 ? { ...a, priority: 60 } : a));
  test.each([
    ['account1 alone at the top of the routable accounts, account3 tied with it but blocked', {}, T0, [ACC1], [ACC2, ACC3]],
    ['account3 back from its cooldown ties account1, so neither is first on its own', {}, AFTER_COOLDOWN, [], [ACC1, ACC2, ACC3]],
    ['round-robin has no line to be first in', { strategy: 'round-robin' as const }, T0, [], [ACC1, ACC2, ACC3]],
    ['a blocked account above everyone is not first in line, and making it primary would change nothing', { accounts: blockedOnTop }, T0, [ACC1], [ACC2]],
  ] as const)('primary: %s', (_label, s, now, primary, makePrimary) => {
    const d = deck(s, now);
    expect(d.accounts.filter((a) => a.routing.primary).map((a) => a.id)).toEqual([...primary]);
    expect(d.accounts.filter((a) => a.can.makePrimary).map((a) => a.id)).toEqual([...makePrimary]);
  });

  test('Serve first names the priority it would set: ten above the highest other account, none where the account already outranks them all', () => {
    const firstTo = (accounts: readonly CpaAccount[]) => deck({ accounts }).accounts.map((a) => [a.id, a.routing.firstTo]);
    expect(firstTo(cpaAccounts())).toEqual([
      [ACC1, 60],
      [ACC2, 60],
      [ACC3, 60],
    ]);
    expect(firstTo(cpaAccounts().map((a): CpaAccount => (a.id === ACC1 ? { ...a, priority: 70 } : a)))).toEqual([
      [ACC1, null],
      [ACC2, 80],
      [ACC3, 80],
    ]);
  });
});

describe('clearing a cooldown', () => {
  const a1 = account(ACC1);
  const a3 = account(ACC3);
  const canClear = (a: CpaAccount, now = T0) => deriveDeck(snapshot({ accounts: [a], now }), now).accounts[0]!.can.clearCooldown;

  test.each([
    ['an account with no cooldown', a1, T0, false],
    ['account3 in its credential cooldown', a3, T0, true],
    ['account3 once the cooldown has passed', a3, AFTER_COOLDOWN, false],
    ['an unavailable account that CPA will retry later', { ...a1, unavailable: true, nextRetryAfter: plus(T0, MIN) }, T0, true],
    ['an unavailable account whose retry time has passed', { ...a1, unavailable: true, nextRetryAfter: plus(T0, -MIN) }, T0, false],
  ] as const)('%s: %p', (_label, a, now, expected) => {
    expect(canClear(a, now)).toBe(expected);
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
    ['only a model-scoped quota cooldown', { ...bare(a3), cooldowns: a3.cooldowns.filter((c) => c.scope === 'model') }, null, T0, false],
    ['a credential cooldown for a non-quota reason', { ...bare(a3), cooldowns: [{ scope: 'credential', reason: 'unauthorized', retryAt: plus(T0, MIN), httpStatus: 401 }] }, null, T0, false],
    ['a credential quota cooldown alone', { ...bare(a3), cooldowns: [{ scope: 'credential', reason: 'quota', retryAt: plus(T0, MIN), httpStatus: 429 }] }, null, T0, true],
  ] as const)('%s: %p', (_label, a, poll, now, expected) => {
    expect(isAtWall(a, poll, now)).toBe(expected);
  });
});

describe('window lifecycle', () => {
  const rows = (poll: Sample<readonly Limit[]> | null, a: CpaAccount | null, now: Instant) =>
    mergeLimits(poll, a?.headers ?? null, now).map((l): unknown[] => [l.key, l.phase, l.left, l.source.kind, l.other?.kind ?? null, l.other?.left ?? null]);

  test('fixture 1 has no session limit: the session row is idle and fully free, never 0% or 100% used', () => {
    expect(rows(pollOf('anthropic-usage-1.json', T0), null, T0)).toEqual([
      ['session', 'idle', 100, 'poll', null, null],
      ['weekly_all', 'open', 99, 'poll', null, null],
      ['weekly_scoped:Fable', 'open', 100, 'poll', null, null],
    ]);
  });

  test('headers only: account1 has 83% / 73% left from headers, with resets from the epoch headers', () => {
    const m = mergeLimits(null, account(ACC1).headers, T0);
    expect(rows(null, account(ACC1), T0)).toEqual([
      ['session', 'open', 83, 'headers', null, null],
      ['weekly_all', 'open', 73, 'headers', null, null],
    ]);
    expect(m[0]!.resetsAt).toBe(at('2026-11-04T17:00:00Z'));
  });

  test('a poll older than the headers: headers drawn, poll kept as the other reading', () => {
    expect(rows(pollOf('anthropic-usage-2.json', plus(T0, -5 * MIN)), account(ACC1), T0).slice(0, 2)).toEqual([
      ['session', 'open', 83, 'headers', 'poll', 88],
      ['weekly_all', 'open', 73, 'headers', 'poll', 73],
    ]);
  });

  test('a poll newer than the headers: poll drawn, headers kept as the other reading', () => {
    expect(rows(pollOf('anthropic-usage-2.json', T0), account(ACC1), T0).slice(0, 2)).toEqual([
      ['session', 'open', 88, 'poll', 'headers', 83],
      ['weekly_all', 'open', 73, 'poll', 'headers', 73],
    ]);
  });

  test('after resetsAt with nothing newer, the row is lapsed and the old reading is gone', () => {
    const m = mergeLimits(pollOf('anthropic-usage-3.json', T0), null, AFTER_COOLDOWN);
    expect(m[0]).toMatchObject({ key: 'session', phase: 'lapsed', percent: null, left: null, severity: 'normal', resetsAt: at('2026-11-04T14:20:00.412Z') });
    expect(m[1]).toMatchObject({ key: 'weekly_all', phase: 'open', percent: 60, left: 40 });
  });

  test('what is left is 100 minus what is used, and nothing is left at the wall or past it', () => {
    const left = (used: number) => {
      const poll = { value: usage('anthropic-usage-2.json', 'normal').limits.map((l) => (l.kind === 'session' ? { ...l, percent: used as never } : l)), at: T0 };
      return mergeLimits(poll, null, T0)[0]!;
    };
    expect(left(12)).toMatchObject({ percent: 12, left: 88 });
    expect(left(100)).toMatchObject({ percent: 100, left: 0 });
    expect(left(101)).toMatchObject({ percent: 101, left: 0 });
    expect(left(0)).toMatchObject({ percent: 0, left: 100 });
  });

  describe('what the meter fill says', () => {
    const HOUR = 3_600_000;
    const toneOf = (kind: string, used: number, resetsInMs: number | null, severity: Severity = 'normal') => {
      const l: Limit = { kind, percent: used as Percent, severity, resetsAt: resetsInMs === null ? null : plus(T0, resetsInMs), scopeModel: null, isActive: false };
      return mergeLimits({ value: [l], at: T0 }, null, T0).find((v) => v.key === kind)!.tone;
    };

    test.each([
      ['most of the session left, but burning faster than time, runs out before the reset', 12, 4.5 * HOUR, 'normal', 'warning'],
      ['a quarter of the session left with a tenth of the time to go lasts, so it stays neutral', 75, 0.5 * HOUR, 'normal', 'normal'],
      ['half used in half the time lasts exactly to the reset', 50, 2.5 * HOUR, 'normal', 'normal'],
      ['a full window is critical however Anthropic grades it', 100, 3 * HOUR, 'normal', 'critical'],
      ['a warning from Anthropic keeps its tone though the pace lasts', 10, HOUR, 'warning', 'warning'],
      ['a critical reading stays critical', 100, HOUR, 'critical', 'critical'],
      ['too early to project, a quarter or less left warns', 80, 5 * HOUR - 6 * MIN, 'normal', 'warning'],
      ['too early to project, more than a quarter left is neutral', 30, 5 * HOUR - 6 * MIN, 'normal', 'normal'],
    ] as const)('%s', (_what, used, resetsIn, severity, tone) => {
      expect(toneOf('session', used, resetsIn, severity)).toBe(tone);
    });

    test('with no pace to go on, a quarter or less left warns', () => {
      expect(toneOf('monthly', 75, HOUR)).toBe('warning');
      expect(toneOf('monthly', 74, HOUR)).toBe('normal');
      expect(toneOf('session', 80, null)).toBe('warning');
      expect(toneOf('session', 30, null)).toBe('normal');
    });

    test('an idle window has all of its room, and a lapsed one has no reading to warn about', () => {
      expect(mergeLimits(pollOf('anthropic-usage-1.json', T0), null, T0)[0]).toMatchObject({ phase: 'idle', tone: 'normal' });
      expect(mergeLimits(pollOf('anthropic-usage-3.json', T0), null, AFTER_COOLDOWN)[0]).toMatchObject({ phase: 'lapsed', tone: 'normal' });
    });
  });

  test('a newer header window after a reset replaces the lapsed poll row', () => {
    const fresh: CpaAccount = {
      ...account(ACC3),
      headers: { observedAt: plus(AFTER_COOLDOWN, -MIN), status: 'allowed', resetsAt: null, overageDisabledReason: null, windows: [{ key: '5h', percent: 4 as never, resetsAt: at('2026-11-04T19:20:00Z'), status: 'allowed' }] },
    };
    expect(mergeLimits(pollOf('anthropic-usage-3.json', T0), fresh.headers, AFTER_COOLDOWN)[0]).toMatchObject({ phase: 'open', percent: 4, source: { kind: 'headers' }, other: null });
  });

  test('a rejected header status draws as critical', () => {
    expect(mergeLimits(null, account(ACC3).headers, T0)[0]).toMatchObject({ key: 'session', percent: 100, left: 0, severity: 'critical' });
  });

  test('a poll without a session limit and older 5h headers stays idle and keeps the header value as the other reading', () => {
    const m = mergeLimits(pollOf('anthropic-usage-1.json', T0), account(ACC1).headers, T0);
    expect(m[0]).toMatchObject({ key: 'session', phase: 'idle', percent: null, left: 100, other: { kind: 'headers', left: 83 } });
  });

  test('a lapsed row still carries the other reading', () => {
    const older = { ...account(ACC1).headers!, observedAt: plus(T0, -MIN), windows: [{ key: '5h', percent: 40 as never, resetsAt: at('2026-11-04T19:20:00Z'), status: 'allowed' as const }] };
    const m = mergeLimits(pollOf('anthropic-usage-3.json', T0), older, AFTER_COOLDOWN);
    expect(m[0]).toMatchObject({ key: 'session', phase: 'lapsed', other: { kind: 'headers', left: 60 } });
  });

  describe('which window is limiting', () => {
    const poll = (name: string, change: (l: Limit) => Limit, readAt = T0): Sample<readonly Limit[]> => ({ value: usage(name, 'normal').limits.map(change), at: readAt });
    const limiting = (p: Sample<readonly Limit[]> | null, a: CpaAccount | null, now: Instant) =>
      mergeLimits(p, a?.headers ?? null, now).flatMap((l) => (l.limiting ? [l.key] : []));
    const session = (change: Partial<Limit>) => (l: Limit): Limit => (l.kind === 'session' ? { ...l, ...change } : l);
    const warned = (a: CpaAccount): CpaAccount => ({
      ...a,
      headers: { ...a.headers!, windows: a.headers!.windows.map((w) => (w.key === '7d' ? { ...w, status: 'allowed_warning' } : w)) },
    });

    test.each([
      ['the active window at critical', poll('anthropic-usage-3.json', (l) => l), null, T0, ['session']],
      ['the active window at warning', poll('anthropic-usage-3.json', session({ severity: 'warning' })), null, T0, ['session']],
      ['the active window at normal is only the tightest, not limiting', poll('anthropic-usage-3.json', session({ severity: 'normal' })), null, T0, []],
      ['a critical window that is not the active one', poll('anthropic-usage-3.json', session({ isActive: false })), null, T0, []],
      ['the active window after its reset has lapsed', poll('anthropic-usage-3.json', (l) => l), null, AFTER_COOLDOWN, []],
      ['account1 at 12% and 27%: the active weekly window is at normal', poll('anthropic-usage-2.json', (l) => l), null, T0, []],
      ['newer headers at warning on the window the poll marked active', poll('anthropic-usage-2.json', (l) => l, plus(T0, -5 * MIN)), warned(account(ACC1)), T0, ['weekly_all']],
    ] as const)('%s', (_label, p, a, now, expected) => {
      expect(limiting(p, a, now)).toEqual(expected as never);
    });
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
  const limitsOf = (feeds: AccountFeeds) => mergeLimits(feeds.limits.last, null, T0);
  const offersOf = (feeds: AccountFeeds, atWall = true, claims: ClaimRecord[] = []) => deriveOffers(ACC3, feeds, atWall, claims, T0, limitsOf(feeds));
  const offers = (feeds = feedsFrom(synthetic, T0), atWall = true, claims: ClaimRecord[] = []) =>
    Object.fromEntries(offersOf(feeds, atWall, claims).map((o) => [o.program, o.state])) as Record<ClaimRecord['program'], OfferState>;

  test('at the wall with the synthetic read, both programs are claimable', () => {
    expect(offers()).toEqual({ juniper_tide: { kind: 'claimable', grant: null }, cedar_ember: { kind: 'claimable', grant: 'grant_example_1' as GrantId } });
  });

  test('away from the wall juniper is held, remembering that the last read was claimable', () => {
    expect(offers(undefined, false).juniper_tide).toEqual({ kind: 'held', lastAt: T0, lastClaimable: true });
  });

  test('a sending claim holds its program in flight whatever the data says', () => {
    expect(offers(undefined, true, [claim({ kind: 'sending' })]).juniper_tide).toEqual({ kind: 'in_flight', claim: 'c1' as ClaimId, phase: 'sending', result: null });
  });

  test('an unknown outcome stays in flight until a read taken a minute after it, then the read decides', () => {
    const maybeSent = claim({ kind: 'maybe_sent', at: plus(T0, MIN), why: 'timed out' });
    const inFlight: OfferState = { kind: 'in_flight', claim: 'c1' as ClaimId, phase: 'maybe_sent', result: null };
    expect(offers(feedsFrom(synthetic, T0), true, [maybeSent]).juniper_tide).toEqual(inFlight);
    expect(offers(feedsFrom(synthetic, plus(T0, MIN + 30_000)), true, [maybeSent]).juniper_tide).toEqual(inFlight);
    const consumed = { ...synthetic, juniper: { ...(synthetic.mode === 'wall' ? synthetic.juniper! : j({})), available: false, nextAvailableAt: at('2026-11-11T09:00:00Z') } };
    expect(offers(feedsFrom(consumed, plus(T0, 2 * MIN)), true, [maybeSent]).juniper_tide).toEqual({ kind: 'waiting', until: at('2026-11-11T09:00:00Z') });
  });

  test('a settled claim holds the program until a read taken a minute after it, so the old offer never invites a repeat', () => {
    const settled = claim({ kind: 'settled', at: plus(T0, MIN), outcome: { result: 'reset', reason: null, resetsLeft: null, cleared: ['five_hour'], nextAvailableAt: null }, followup: 'done' });
    expect(offers(feedsFrom(synthetic, T0), true, [settled]).juniper_tide).toEqual({ kind: 'in_flight', claim: 'c1' as ClaimId, phase: 'confirming', result: 'reset' });
    expect(offers(feedsFrom(synthetic, plus(T0, MIN + 30_000)), true, [settled]).juniper_tide.kind).toBe('in_flight');
    expect(offers(feedsFrom(synthetic, plus(T0, 2 * MIN)), true, [settled]).juniper_tide.kind).toBe('claimable');
  });

  test('never read is unknown/never_read; an error with no data is unknown/failing', () => {
    expect(offers(emptyFeeds(), true).cedar_ember).toEqual({ kind: 'unknown', why: 'never_read' });
    const failing = { ...emptyFeeds(), cedar: { ...emptySource<CedarEmber | null>(), error: { value: { kind: 'rate_limited' as const, retryAt: plus(T0, MIN) }, at: T0 } } };
    expect(offers(failing, true).cedar_ember).toEqual({ kind: 'unknown', why: 'failing' });
  });

  test('a grant says in plain words what it clears and keeps the raw window codes', () => {
    const cedarOffer = offersOf(feedsFrom(synthetic, T0)).find((o) => o.program === 'cedar_ember')!;
    expect(cedarOffer.grants[0]).toMatchObject({ clears: ['five_hour'], clearsText: 'the session (5h) limit' });
  });

  test('the unknown-outcome banner names the program by its label', () => {
    const maybeSent = claim({ kind: 'maybe_sent', at: T0, why: 'timed out' });
    const d = deriveDeck(snapshot({ claims: [maybeSent], feeds: { [ACC3]: feedsFrom(synthetic, T0) } }), T0);
    expect(d.banners).toContainEqual({ kind: 'claim_unknown', claim: 'c1' as ClaimId, email: 'account3@example.com', program: 'juniper_tide', label: 'Weekly session reset' });
  });

  describe('naming a reset by what it clears', () => {
    const withGrants = (grants: CedarEmber['grants']): AccountFeeds => {
      const f = feedsFrom(synthetic, T0);
      return { ...f, cedar: { ...f.cedar, last: { value: c({ grants }), at: T0 } } };
    };
    const names = (feeds: AccountFeeds) =>
      Object.fromEntries(deriveDeck(snapshot({ feeds: { [ACC3]: feeds } }), T0).accounts.find((x) => x.id === ACC3)!.offers.map((o) => [o.program, [o.what, o.name]]));

    test('both resets clear the session limit, so each is a session reset, told apart by its program and a lone grant by what is left of it', () => {
      expect(names(feedsFrom(synthetic, T0))).toEqual({
        juniper_tide: ['Session reset', 'Session reset · weekly'],
        cedar_ember: ['Session reset', 'Session reset · bonus, 2 of 3 left'],
      });
    });

    test('each Claim button names its reset in a word', () => {
      expect(offersOf(feedsFrom(synthetic, T0)).map((o) => [o.program, o.short])).toEqual([
        ['juniper_tide', 'weekly'],
        ['cedar_ember', 'bonus'],
      ]);
    });

    test.each([
      ['a weekly bonus', ['seven_day'], ['Weekly reset', 'Weekly reset · bonus, 2 of 3 left']],
      ['a bonus clearing both', ['five_hour', 'seven_day'], ['Session and weekly reset', 'Session and weekly reset · bonus, 2 of 3 left']],
      ['a bonus naming nothing', [], ['Bonus reset', 'Bonus reset, 2 of 3 left']],
    ] as const)('%s is named by what it clears, and the weekly one stays a session reset', (_label, clears, bonus) => {
      expect(names(withGrants([{ ...grant, clears: [...clears] }]))).toEqual({ juniper_tide: ['Session reset', 'Session reset · weekly'], cedar_ember: [...bonus] });
    });

    test('several grants say what is left of each in their own list, so the name leaves the count out', () => {
      const second = { ...grant, id: 'grant_example_2' as GrantId, label: 'Second', resetsLeft: 1 };
      expect(names(withGrants([grant, second])).cedar_ember).toEqual(['Session reset', 'Session reset · bonus']);
    });

    test('an account with no grants names its bonus reset by its program alone', () => {
      expect(names(feedsFrom(usage('anthropic-usage-at-wall-1.json', 'wall'), T0)).cedar_ember).toEqual(['Bonus reset', 'Bonus reset']);
    });

    test('the overview and the card name a claimable reset identically, and the overview groups them by account', () => {
      const d = deriveDeck(snapshot({ feeds: { [ACC3]: feedsFrom(synthetic, T0) } }), T0);
      const cardNames = d.accounts.find((a) => a.id === ACC3)!.offers.map((o) => o.name);
      expect(d.overview.claimable).toMatchObject([
        {
          account: ACC3,
          email: 'account3@example.com',
          resets: [
            { program: 'juniper_tide', grant: null, name: cardNames[0]!, detail: null },
            { program: 'cedar_ember', grant: 'grant_example_1' as GrantId, name: cardNames[1]!, detail: '2 of 3 left' },
          ],
        },
      ]);
      expect(d.overview.claimableCount).toBe(2);
    });

    test('an account with nothing claimable is left out of the overview and the count', () => {
      const d = deriveDeck(snapshot({ feeds: { [ACC1]: feedsFrom(usage('anthropic-usage-at-wall-1.json', 'wall'), T0) } }), T0);
      expect(d.overview.claimable).toEqual([]);
      expect(d.overview.claimableCount).toBe(0);
    });
  });

  describe('whether a claim helps now', () => {
    const sessionResets = at('2026-11-04T14:20:00.412Z');
    const verdictOf = (s: Parameters<typeof snapshot>[0]) => {
      const o = deriveDeck(snapshot({ feeds: { [ACC3]: feedsFrom(synthetic, T0) }, ...s }), T0).overview;
      return { verdict: o.claimable.find((x) => x.account === ACC3)!.verdict, order: o.order };
    };
    const change = (f: (a: CpaAccount) => CpaAccount, ids: readonly AccountId[]) => cpaAccounts().map((a) => (ids.includes(a.id) ? f(a) : a));

    test('other accounts in line and not at a limit have room, so it is not needed now, and the blocked account is back when the serve order says', () => {
      const { verdict, order } = verdictOf({});
      expect(verdict).toEqual({
        kind: 'not_needed',
        room: [
          { account: ACC1, email: 'account1@example.com' },
          { account: ACC2, email: 'account2@example.com' },
        ],
        backAt: sessionResets,
      });
      expect(order.lines.find((l) => l.account === ACC3)).toMatchObject({ kind: 'blocked', until: verdict.backAt });
    });

    test('an account in line but at its limit has no room, so with the rest disabled a claim is worth it', () => {
      const accounts = change((a) => ({ ...a, disabled: true }), [ACC1]);
      const feeds = { [ACC3]: feedsFrom(synthetic, T0), [ACC2]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0) };
      expect(verdictOf({ accounts, feeds }).verdict).toEqual({ kind: 'worth_claiming', backAt: sessionResets });
    });

    test('an account CPA does not block is back when the limit its resets clear resets on its own, and is never its own room', () => {
      const accounts = change((a) => ({ ...a, cooldowns: [], unavailable: false, nextRetryAfter: null, statusMessage: null }), [ACC3]);
      const { verdict } = verdictOf({ accounts });
      expect(verdict).toMatchObject({ kind: 'not_needed', backAt: sessionResets });
      expect(verdict.kind === 'not_needed' && verdict.room.map((r) => r.account)).toEqual([ACC1, ACC2]);
    });
  });

  describe('what a claim saves', () => {
    const selfResetsOf = (feeds: AccountFeeds, program: ClaimRecord['program']) => offersOf(feeds).find((o) => o.program === program)!.selfResets;
    const sessionAt = at('2026-11-04T14:20:00.412Z');
    const weeklyAt = at('2026-11-04T19:00:00.412Z');

    test('the weekly reset names when the session limit would reset on its own', () => {
      expect(selfResetsOf(feedsFrom(synthetic, T0), 'juniper_tide')).toEqual([{ what: 'the session limit', at: sessionAt }]);
    });

    test('a grant that clears both limits names both, session first', () => {
      const f = feedsFrom(synthetic, T0);
      const both = { ...f, cedar: { ...f.cedar, last: { value: c({ grants: [{ ...grant, clears: ['five_hour', 'seven_day'] }] }), at: T0 } } };
      expect(selfResetsOf(both, 'cedar_ember')).toEqual([
        { what: 'the session limit', at: sessionAt },
        { what: 'the weekly limit', at: weeklyAt },
      ]);
    });

    test('a limit with no open window has nothing to wait for, so nothing is claimed about it', () => {
      const f = feedsFrom(synthetic, T0);
      const idle = { ...f, limits: { ...f.limits, last: { value: f.limits.last!.value.filter((l) => l.kind !== 'session'), at: T0 } } };
      expect(selfResetsOf(idle, 'juniper_tide')).toEqual([]);
      const lapsed = { ...f, limits: { ...f.limits, last: { value: f.limits.last!.value.map((l) => (l.kind === 'session' ? { ...l, resetsAt: plus(T0, -MIN) } : l)), at: T0 } } };
      expect(selfResetsOf(lapsed, 'juniper_tide')).toEqual([]);
    });
  });

  describe('the quiet line', () => {
    const noGrants = usage('anthropic-usage-at-wall-1.json', 'wall');
    const quiet = (feeds = feedsFrom(noGrants, T0), atWall = true, claims: ClaimRecord[] = []) => quietOffers(offersOf(feeds, atWall, claims));
    const usedThisWeek = { ...noGrants, juniper: { ...j({}), available: false, nextAvailableAt: at('2026-11-11T09:00:00Z') } };
    const enrolledNowhere = () => {
      const f = feedsFrom(noGrants, T0);
      return { ...f, juniper: { ...f.juniper, last: { value: null, at: T0 } }, cedar: { ...f.cedar, last: { value: null, at: T0 } } };
    };

    test('held and ineligible offers collapse to a few phrases that say why', () => {
      expect(quiet(feedsFrom(noGrants, T0), false)).toEqual(['none', 'weekly reset offered at limit', 'no bonus resets']);
      expect(quiet(enrolledNowhere())).toEqual(['none', 'weekly reset not enrolled', 'bonus resets not enrolled']);
    });

    test('a reason without a short form falls back to its plain-words explanation', () => {
      const controlArm = { ...noGrants, juniper: j({ arm: 'control' }) };
      expect(quiet(feedsFrom(controlArm, T0))).toEqual(['none', 'in the experiment, but in the arm that is not offered resets', 'no bonus resets']);
    });

    test.each([
      ['a claimable offer', feedsFrom(synthetic, T0), []],
      ['a waiting offer', feedsFrom(usedThisWeek, T0), []],
      ['a claim in flight', feedsFrom(noGrants, T0), [claim({ kind: 'sending' })]],
      ['an offer never read', emptyFeeds(), []],
    ] as const)('stays the full block for %s', (_label, feeds, claims) => {
      expect(quiet(feeds, true, [...claims])).toBeNull();
    });

    test.each(['surface', 'cli_version'])('stays the full block when Anthropic rejects Headroom itself (%s)', (reason) => {
      const refused = { ...noGrants, juniper: j({ eligible: false, ineligibleReason: reason }) };
      expect(quiet(feedsFrom(refused, T0))).toBeNull();
    });

    test('stays the full block when a read is failing', () => {
      const failing = { ...feedsFrom(noGrants, T0), cedar: { ...emptySource<CedarEmber | null>(), error: { value: { kind: 'rate_limited' as const, retryAt: plus(T0, MIN) }, at: T0 } } };
      expect(quiet(failing)).toBeNull();
    });

    test('reaches the card, and a claimable card keeps its full block', () => {
      const d = deriveDeck(snapshot({ feeds: { [ACC1]: feedsFrom(noGrants, T0), [ACC3]: feedsFrom(synthetic, T0) } }), T0);
      const card = (id: typeof ACC1) => d.accounts.find((a) => a.id === id)!;
      expect(card(ACC1).quietOffers?.[0]).toBe('none');
      expect(card(ACC3).quietOffers).toBeNull();
      expect(card(ACC2).quietOffers).toBeNull();
    });
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

describe('the serve order', () => {
  const threeRead = {
    [ACC1]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
    [ACC2]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
    [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
  };
  const seen = (account: AccountId, ago = 10_000) => ({ account, lastAt: plus(T0, -ago), recent: 3 });
  const overview = (s: Parameters<typeof snapshot>[0]) => deriveDeck(snapshot({ feeds: threeRead, ...s }), T0).overview;
  const places = (o: { readonly order: ServeOrderView }) => o.order.lines.map((l) => [l.account, l.kind === 'in_line' ? l.rank : l.kind]);
  const change = (id: AccountId, f: (a: CpaAccount) => CpaAccount) => cpaAccounts().map((a) => (a.id === id ? f(a) : a));
  const quiet = (a: CpaAccount): CpaAccount => ({ ...a, cooldowns: [], unavailable: false, nextRetryAfter: null, statusMessage: null });

  test('fill-first: the accounts in line by priority with the room their rows draw, then the blocked one, back when its session resets', () => {
    const d = deriveDeck(snapshot({ feeds: threeRead, serving: [seen(ACC1)] }), T0);
    const column = (key: string) => d.accounts.map((a) => a.limits.find((l) => l.key === key)!.left as number | null);
    expect(column('session')).toEqual([88, 100, 0]);
    expect(column('weekly_all')).toEqual([73, 99, 40]);
    expect(d.overview.order).toEqual({
      rotates: false,
      lines: [
        { account: ACC1, email: 'account1@example.com', kind: 'in_line', rank: 1, session: 88, weekly: 73 },
        { account: ACC2, email: 'account2@example.com', kind: 'in_line', rank: 2, session: 100, weekly: 99 },
        { account: ACC3, email: 'account3@example.com', kind: 'blocked', until: at('2026-11-04T14:20:00.412Z'), reason: 'credential_quota' },
      ],
    } as never);
  });

  test('a blocked account whose cooldown ends 17 s after its session reset is back at the one time the next reset and its row both say', () => {
    const d = deriveDeck(snapshot({ feeds: threeRead, serving: [seen(ACC1)] }), T0);
    const account3 = d.accounts.find((a) => a.id === ACC3)!;
    expect(account3.routing.role).toMatchObject({ kind: 'blocked', until: at('2026-11-04T14:20:17.000Z') });
    expect(d.overview.order.lines[2]).toMatchObject({ until: d.overview.nextReset!.at });
    expect(account3.trouble?.limit?.liftsAt).toBe(d.overview.nextReset!.at);
  });

  test('a blocked account with no window read from a poll or headers is back when CPA says', () => {
    const o = overview({ accounts: change(ACC3, (a) => ({ ...a, headers: null })), feeds: {}, serving: [seen(ACC1)] });
    expect(o.order.lines[2]).toMatchObject({ kind: 'blocked', until: at('2026-11-04T14:20:17.000Z') });
  });

  test('rank 1 is where the Serving tile says a new session lands, even while another account serves by affinity', () => {
    const o = overview({ serving: [seen(ACC2)] });
    expect(o.serving.map((s) => s.account)).toEqual([ACC2]);
    expect(o.target?.account).toBe(ACC1);
    expect(places(o)).toEqual([
      [ACC1, 1],
      [ACC2, 2],
      [ACC3, 'blocked'],
    ]);
  });

  test('a higher priority moves an account up the line', () => {
    const o = overview({ accounts: change(ACC2, (a) => ({ ...a, priority: 60 })), serving: [seen(ACC1)] });
    expect(places(o)).toEqual([
      [ACC2, 1],
      [ACC1, 2],
      [ACC3, 'blocked'],
    ]);
    expect(o.target?.account).toBe(ACC2);
  });

  test('among equal priorities the account answered from most recently goes first, as the Serving tile predicts', () => {
    const accounts = change(ACC3, (a) => ({ ...quiet(a), headers: null }));
    const o = overview({ accounts, feeds: { ...threeRead, [ACC3]: threeRead[ACC2]! }, serving: [seen(ACC1, 10 * MIN), seen(ACC3, 5 * MIN)] });
    expect(o.target?.account).toBe(ACC3);
    expect(places(o)).toEqual([
      [ACC3, 1],
      [ACC1, 2],
      [ACC2, 3],
    ]);
  });

  test('an account at its limit that CPA no longer blocks is in line where its priority puts it, with nothing left', () => {
    const o = overview({ accounts: change(ACC3, quiet), serving: [seen(ACC1)] });
    expect(places(o)).toEqual([
      [ACC1, 1],
      [ACC3, 2],
      [ACC2, 3],
    ]);
    expect(o.order.lines[1]).toMatchObject({ kind: 'in_line', session: 0, weekly: 40 });
  });

  test('blocked accounts follow the line, soonest back first, and disabled ones come last', () => {
    const later = at('2026-11-04T15:00:00.000Z');
    const accounts = cpaAccounts().map((a): CpaAccount =>
      a.id === ACC1 ? { ...a, cooldowns: [{ scope: 'credential', reason: 'quota', retryAt: later, httpStatus: null }] } : a.id === ACC2 ? { ...a, disabled: true } : a,
    );
    const o = overview({ accounts, serving: [seen(ACC1)] });
    expect(places(o)).toEqual([
      [ACC3, 'blocked'],
      [ACC1, 'blocked'],
      [ACC2, 'disabled'],
    ]);
    expect(o.order.lines[1]).toMatchObject({ until: later });
    expect(o.target).toBeNull();
  });

  test('round-robin keeps the same list and says the order rotates', () => {
    const fillFirst = overview({ serving: [seen(ACC1)] }).order;
    expect(fillFirst.rotates).toBe(false);
    expect(overview({ serving: [seen(ACC1)], strategy: 'round-robin' }).order).toEqual({ ...fillFirst, rotates: true });
  });

  test('an account with no limits read yet still takes requests, so it is in line with no figures', () => {
    const o = overview({ accounts: change(ACC2, (a) => ({ ...a, headers: null })), feeds: { [ACC1]: threeRead[ACC1]! }, serving: [seen(ACC1)] });
    expect(o.order.lines[1]).toEqual({ account: ACC2, email: 'account2@example.com', kind: 'in_line', rank: 2, session: null, weekly: null } as never);
  });
});

describe('the accounts table columns', () => {
  const columns = (feeds: Record<string, AccountFeeds>, accounts = cpaAccounts()) => deriveDeck(snapshot({ accounts, feeds }), T0).limitColumns;

  test('every window any account reports is one column, session first, then weekly, then the scoped weeklies', () => {
    const feeds = {
      [ACC1]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
      [ACC2]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
      [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
    };
    const keys = columns(feeds).flatMap((c) => [c.key, ...c.nested.map((n) => n.key)]);
    expect(keys.slice(0, 2)).toEqual(['session', 'weekly_all']);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of deriveDeck(snapshot({ feeds }), T0).accounts) for (const l of a.limits) expect(keys).toContain(l.key);
  });

  const fable = feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0);
  const shiftFable = (f: AccountFeeds, ms: number): AccountFeeds => ({
    ...f,
    limits: { ...f.limits, last: { value: f.limits.last!.value.map((l) => (l.kind === 'weekly_scoped' ? { ...l, resetsAt: plus(l.resetsAt!, ms) } : l)), at: T0 } },
  });

  test('a scoped window that resets with Weekly on every account rides in the Weekly cell, named by its model and glossed, and takes no column', () => {
    expect(columns({ [ACC1]: fable, [ACC2]: fable })).toEqual([
      { key: 'session', label: 'Session', gloss: null, nested: [] },
      { key: 'weekly_all', label: 'Weekly', gloss: null, nested: [{ key: 'weekly_scoped:Fable', name: 'Fable', label: 'Weekly · Fable', gloss: 'Fable models only' }] },
    ]);
  });

  test('a scoped window whose reset differs from Weekly on any one account gets a column of its own, after Weekly', () => {
    expect(columns({ [ACC1]: fable, [ACC2]: shiftFable(fable, 2 * MIN) })).toEqual([
      { key: 'session', label: 'Session', gloss: null, nested: [] },
      { key: 'weekly_all', label: 'Weekly', gloss: null, nested: [] },
      { key: 'weekly_scoped:Fable', label: 'Weekly · Fable', gloss: 'Fable models only', nested: [] },
    ]);
  });

  test('resets that the page shows as the same minute count as the same moment', () => {
    expect(columns({ [ACC1]: shiftFable(fable, 40_000) }).map((c) => c.key)).toEqual(['session', 'weekly_all']);
  });

  test('a scoped window only one account reports, on an account with no Weekly window, still gets its column', () => {
    const opus: Limit = { kind: 'weekly_scoped', scopeModel: 'Opus', percent: 40 as never, severity: 'normal', resetsAt: plus(T0, 60 * MIN), isActive: false };
    const onlyOpus = { ...fable, limits: { ...fable.limits, last: { value: [opus], at: T0 } } };
    expect(columns({ [ACC1]: onlyOpus, [ACC2]: fable })).toContainEqual({ key: 'weekly_scoped:Opus', label: 'Weekly · Opus', gloss: 'Opus models only', nested: [] });
  });

  test('no account read yet and no traffic: no columns', () => {
    expect(columns({}, cpaAccounts().map((a): CpaAccount => ({ ...a, headers: null })))).toEqual([]);
  });

  describe('extra usage', () => {
    const threeRead = {
      [ACC1]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
      [ACC2]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
      [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
    };
    const withSpend = (f: AccountFeeds, over: Partial<Spend>): AccountFeeds => ({ ...f, spend: { ...f.spend, last: { value: { ...f.spend.last!.value!, ...over }, at: T0 } } });
    const hasColumn = (feeds: Record<string, AccountFeeds>) => deriveDeck(snapshot({ feeds }), T0).extraUsageColumn;
    const usd = (minor: number) => ({ minor, currency: 'USD', exponent: 2 }) as Spend['used'];

    test('off, a zero budget and a used-up cap say nothing a meter could, so no account gets a column', () => {
      const d = deriveDeck(snapshot({ feeds: threeRead }), T0);
      expect(d.accounts.map((a) => a.spend?.poll?.state)).toEqual(['off', 'no_budget', 'cap_used']);
      expect(d.extraUsageColumn).toBe(false);
    });

    test.each([
      ['on with room under a cap', { enabled: true, used: usd(2_500), limit: usd(10_000) }],
      ['on with no cap', { enabled: true, used: usd(2_500), limit: null }],
    ] as const)('one account %s gives every account the column', (_label, over) => {
      expect(hasColumn({ ...threeRead, [ACC1]: withSpend(threeRead[ACC1]!, over) })).toBe(true);
    });
  });
});

describe('the next reset', () => {
  test('is the soonest reset of any open window, on whichever account it falls', () => {
    const feeds = {
      [ACC1]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
      [ACC2]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
      [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
    };
    expect(deriveDeck(snapshot({ feeds }), T0).overview.nextReset).toEqual({
      account: ACC3,
      email: 'account3@example.com',
      label: 'Session',
      at: at('2026-11-04T14:20:00.412Z'),
    } as never);
  });
});

describe('windows on course to run out', () => {
  const HOUR = 3_600_000;
  const limit = (kind: string, used: number, resetsInMs: number): Limit => ({ kind, percent: used as Percent, severity: 'normal', resetsAt: plus(T0, resetsInMs), scopeModel: null, isActive: false });
  const feeds = (byAccount: Record<AccountId, Limit[]>) =>
    Object.fromEntries(Object.entries(byAccount).map(([id, limits]) => [id, feedsFrom({ ...usage('anthropic-usage-1.json', 'normal'), limits }, T0)]));
  const accounts = cpaAccounts().map((a): CpaAccount => ({ ...a, headers: null, cooldowns: [], unavailable: false, nextRetryAfter: null, statusMessage: null, disabled: a.id === ACC3 }));
  const overview = (byAccount: Record<AccountId, Limit[]>, opts: { readonly serving?: AccountId } = {}) =>
    deriveDeck(snapshot({ accounts, feeds: feeds(byAccount), serving: opts.serving ? [{ account: opts.serving, lastAt: plus(T0, -10_000), recent: 3 }] : [] }), T0).overview;
  const burning = { [ACC1]: [limit('session', 50, 3 * HOUR), limit('weekly_all', 10, 3.5 * 24 * HOUR)], [ACC2]: [limit('weekly_all', 60, 3.5 * 24 * HOUR)] };

  test('every window whose pace says it runs out before its reset, soonest first, with when it runs out, when it resets, and where new sessions go after', () => {
    expect(overview(burning, { serving: ACC1 }).runningOut).toEqual([
      {
        account: ACC1,
        email: 'account1@example.com',
        limit: { key: 'session', label: 'Session' },
        at: plus(T0, 2 * HOUR),
        resetsAt: plus(T0, 3 * HOUR),
        after: { kind: 'next', account: ACC2, email: 'account2@example.com' },
      },
      {
        account: ACC2,
        email: 'account2@example.com',
        limit: { key: 'weekly_all', label: 'Weekly' },
        at: plus(T0, (7 * 5) / 6 * 24 * HOUR - 3.5 * 24 * HOUR),
        resetsAt: plus(T0, 3.5 * 24 * HOUR),
        after: null,
      },
    ] as never);
  });

  test('a window on course to last to its reset is not listed, whichever account serves', () => {
    const o = overview({ [ACC1]: [limit('session', 10, 3 * HOUR)], [ACC2]: burning[ACC2]! }, { serving: ACC1 });
    expect(o.runningOut.map((r) => r.account)).toEqual([ACC2]);
  });

  test('the first in line running out with no account behind it leaves new sessions nowhere to go', () => {
    const alone = accounts.map((a): CpaAccount => (a.id === ACC2 ? { ...a, disabled: true } : a));
    const o = deriveDeck(snapshot({ accounts: alone, feeds: feeds({ [ACC1]: burning[ACC1]! }), serving: [] }), T0).overview;
    expect(o.runningOut.map((r) => r.after)).toEqual([{ kind: 'none' }]);
  });

  test('round-robin has no line for a run-out to hand over, so it names no next account', () => {
    const o = deriveDeck(snapshot({ accounts, feeds: feeds(burning), serving: [], strategy: 'round-robin' }), T0).overview;
    expect(o.runningOut.map((r) => r.after)).toEqual([null, null]);
  });
});

describe('why an account is in trouble', () => {
  const trouble = (change: (a: CpaAccount) => CpaAccount, id = ACC3, now = T0) =>
    deriveDeck(snapshot({ accounts: cpaAccounts().map((a) => (a.id === id ? change(a) : a)), now }), now).accounts.find((a) => a.id === id)!.trouble;
  const model = (name: string, reason: CooldownReason, retryAt: Instant): Cooldown => ({ scope: 'model', model: name, reason, retryAt, httpStatus: null });
  const credential = (reason: CooldownReason, retryAt: Instant): Cooldown => ({ scope: 'credential', reason, retryAt, httpStatus: null });
  const END = at('2026-11-04T14:20:17.000Z');

  test('a blocked account says the plain cause, what is cooling down, and until when', () => {
    expect(trouble((a) => a)).toMatchObject({ cause: 'Monthly spend limit hit', holds: [{ what: 'account and 3 models cooling down', until: END }] });
  });

  describe('the window that holds it', () => {
    const atWall = { [ACC3]: feedsFrom(usage('anthropic-usage-at-wall-3.json', 'wall'), T0) };
    const held = (change: (a: CpaAccount) => CpaAccount, feeds: Record<string, AccountFeeds> = atWall) =>
      deriveDeck(snapshot({ accounts: cpaAccounts().map((a) => (a.id === ACC3 ? change(a) : a)), feeds }), T0).accounts.find((a) => a.id === ACC3)!;

    test('a spend-cap message on an account with its session emptied names the session window, and keeps the message as the cause', () => {
      const a = held((x) => x);
      expect(a.limits.find((l) => l.key === 'session')?.percent).toBe(100 as never);
      expect(a.trouble).toMatchObject({ cause: 'Monthly spend limit hit', limit: { label: 'Session' } });
    });

    test('a quota cooldown with no message names the full window too', () => {
      expect(held((x) => ({ ...x, statusMessage: null, cooldowns: [credential('credential_quota', END)] })).trouble?.limit?.label).toBe('Session');
    });

    test('a cooldown ending 17 s after the session resets is lifted by that reset, and the panel can say when', () => {
      expect(held((x) => x).trouble?.limit).toEqual({ label: 'Session', liftsAt: at('2026-11-04T14:20:00.412Z') });
    });

    test('a cooldown outlasting the reset by half an hour is not lifted by it', () => {
      const later = plus(END, 30 * MIN);
      const unblock = (x: CpaAccount): CpaAccount => ({ ...x, cooldowns: [credential('credential_quota', later)], nextRetryAfter: later });
      expect(held(unblock).trouble?.limit).toEqual({ label: 'Session', liftsAt: null });
    });

    test('a rejected token is not about quota, so a full window does not take the blame', () => {
      const t = held((x) => ({ ...x, statusMessage: null, cooldowns: [credential('unauthorized', END)] })).trouble;
      expect(t).toMatchObject({ cause: 'Token rejected', limit: null });
    });

    test('with no window at its limit nothing is named', () => {
      const roomy = { [ACC3]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0) };
      expect(held((x) => ({ ...x, headers: null }), roomy).trouble).toMatchObject({ cause: 'Monthly spend limit hit', limit: null });
    });
  });

  test('accounts with nothing wrong have no trouble', () => {
    expect(trouble((a) => a, ACC1)).toBeNull();
    expect(trouble((a) => a, ACC2)).toBeNull();
    expect(trouble((a) => ({ ...a, cooldowns: [], unavailable: false, statusMessage: null }))).toBeNull();
  });

  test.each([
    ['CPA message with a known phrase wins over the cooldown code', 'This request would exceed your account\'s monthly spend limit.', 'credential_quota', 'Monthly spend limit hit'],
    ['an unmapped message gives way to the cooldown code', 'Something new broke.', 'unauthorized', 'Token rejected'],
    ['no message: the cooldown code in plain words', null, 'credential_quota', 'No quota left'],
    ['an unmapped message with only an unknown code is shown as it came', 'Something new broke.', 'unknown', 'Something new broke.'],
    ['no message and an unknown code: said so', null, 'unknown', 'Reason unknown'],
  ] as const)('%s', (_label, statusMessage, reason, cause) => {
    expect(trouble((a) => ({ ...a, statusMessage, cooldowns: [credential(reason, END)] }))?.cause).toBe(cause);
  });

  test('the account-wide reason leads over a model reason', () => {
    const t = trouble((a) => ({ ...a, statusMessage: null, cooldowns: [model('claude-opus-5-5', 'unauthorized', END), credential('credential_quota', END)] }));
    expect(t?.cause).toBe('No quota left');
  });

  test('one model cooling down on an account that still routes is named, and the account is not called blocked', () => {
    const t = trouble((a) => ({ ...a, statusMessage: null, unavailable: false, nextRetryAfter: null, cooldowns: [model('claude-opus-5-5', 'quota', END)] }));
    expect(t).toMatchObject({ cause: 'No quota left', holds: [{ what: 'opus-5-5 cooling down', until: END }] });
  });

  test('model cooldowns that outlast the account get their own time', () => {
    const later = plus(END, 25 * MIN);
    const t = trouble((a) => ({ ...a, cooldowns: [credential('credential_quota', END), model('claude-opus-5-5', 'quota', later), model('claude-haiku-5-5', 'quota', later)] }));
    expect(t?.holds).toEqual([
      { what: 'account cooling down', until: END },
      { what: '2 models cooling down', until: later },
    ]);
  });

  test('model cooldowns ending seconds after the account are the same stretch', () => {
    const t = trouble((a) => ({ ...a, cooldowns: [credential('credential_quota', END), model('claude-opus-5-5', 'quota', plus(END, 5_000))] }));
    expect(t?.holds).toEqual([{ what: 'account and opus-5-5 cooling down', until: END }]);
  });

  test('CPA saying unavailable with no retry time is a hold with no end', () => {
    const t = trouble((a) => ({ ...a, cooldowns: [], unavailable: true, nextRetryAfter: null }));
    expect(t?.holds).toEqual([{ what: 'account cooling down', until: null }]);
  });

  test('once the cooldown has ended only CPA\'s last error is left, with no holds', () => {
    expect(trouble((a) => a, ACC3, AFTER_COOLDOWN)).toMatchObject({ cause: 'Monthly spend limit hit', holds: [] });
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

describe('header status', () => {
  const ago = <T>(src: Source<T>, ms: number): Source<T> => ({ ...src, last: { ...src.last!, at: plus(T0, -ms) } });
  const status = (cpa: number, strategy: number, serving: number, change: (s: Snapshot) => Snapshot = (s) => s) => {
    const s = snapshot({ serving: [] });
    return deriveDeck(change({ ...s, cpa: ago(s.cpa, cpa), strategy: ago(s.strategy, strategy), serving: ago(s.serving, serving) }), T0).status;
  };
  const problems = (s: ReturnType<typeof status>) => s.problems.map((f) => [f.feed, f.state]);

  test('with every source fresh nothing is a problem and the newest reading sets the age', () => {
    const s = status(3_000, 53_000, 8_000);
    expect(s.problems).toEqual([]);
    expect(s.newestAgeMs).toBe(3_000);
    expect(s.sources.map((f) => f.feed)).toEqual(['cpa', 'strategy', 'serving']);
  });

  test.each([
    ['history 40 s old is aging', [3_000, 53_000, 40_000], [['serving', 'aging']]],
    ['history 6 min old is stale', [3_000, 53_000, 6 * MIN], [['serving', 'stale']]],
    ['routing 100 s old is aging', [3_000, 100_000, 3_000], [['strategy', 'aging']]],
    ['CPA 20 s old is aging', [20_000, 53_000, 3_000], [['cpa', 'aging']]],
  ] as const)('%s', (_label, [cpa, strategy, serving], expected) => {
    expect(problems(status(cpa, strategy, serving))).toEqual(expected as never);
  });

  test('problems come worst first: failing, stale, never read, then aging', () => {
    const s = status(20_000, 6 * MIN, 3_000, (x) => ({ ...x, serving: { ...x.serving, error: { value: { kind: 'unavailable', message: 'unreadable' }, at: T0 } } }));
    expect(problems(s)).toEqual([
      ['serving', 'failing'],
      ['strategy', 'stale'],
      ['cpa', 'aging'],
    ]);
    const never = status(20_000, 3_000, 3_000, (x) => ({ ...x, strategy: emptySource() }));
    expect(problems(never)).toEqual([
      ['strategy', 'never'],
      ['cpa', 'aging'],
    ]);
  });

  test('a CPA that stopped answering is a failing problem that keeps the error, and the newest reading is still the freshest source', () => {
    const s = status(17_000, 53_000, 3_000, (x) => ({ ...x, cpa: { ...x.cpa, error: { value: { kind: 'cpa_unreachable' }, at: T0 } } }));
    expect(s.problems[0]).toMatchObject({ feed: 'cpa', state: 'failing', ageMs: 17_000, error: { kind: 'cpa_unreachable' } });
    expect(s.newestAgeMs).toBe(3_000);
  });

  test('before any source has answered there is no newest reading', () => {
    const empty = deriveDeck({ ...snapshot({}), cpa: emptySource(), strategy: emptySource(), serving: emptySource() }, T0).status;
    expect(empty.newestAgeMs).toBeNull();
    expect(problems(empty)).toEqual([
      ['cpa', 'never'],
      ['strategy', 'never'],
      ['serving', 'never'],
    ]);
  });
});

describe('card status line', () => {
  const view = (feeds: Record<string, ReturnType<typeof emptyFeeds>>, id: string) => deriveDeck(snapshot({ feeds }), T0).accounts.find((a) => a.id === id)!;
  const sampleAt = <T>(value: T, t: Instant) => ({ ...emptySource<T>(), last: { value, at: t } });

  test('the freshest successful usage read wins over older reads, ignores the profile, and is null before any read', () => {
    const read = feedsFrom(usage('anthropic-usage-2.json', 'normal'), plus(T0, -3 * MIN), 'anthropic-profile-1.json');
    const feeds = {
      ...read,
      juniper: sampleAt(null, plus(T0, -20_000)),
      profile: { ...read.profile, last: { ...read.profile.last!, at: plus(T0, -5_000) } },
    };
    expect(view({ [ACC1]: feeds }, ACC1).read.lastAt).toBe(plus(T0, -20_000));
    expect(view({}, ACC2).read.lastAt).toBeNull();
  });

  test('a failed read does not move the last successful read', () => {
    const t = plus(T0, -8 * MIN);
    const failing = { ...feedsFrom(usage('anthropic-usage-2.json', 'normal'), t), limits: { ...sampleAt([], t), error: { value: { kind: 'upstream' as const, status: 503, message: '' }, at: plus(T0, -MIN) } } };
    expect(view({ [ACC1]: { ...failing, spend: emptySource(), cedar: emptySource() } }, ACC1).read.lastAt).toBe(t);
  });

  test('live overage is critical when Anthropic rejects it, warning on a warning status, and normal when allowed', () => {
    const headers = account(ACC3).headers!;
    const withOverage = (status: 'rejected' | 'allowed_warning' | 'allowed', percent: number) => ({
      ...headers,
      overageDisabledReason: null,
      windows: [...headers.windows.filter((w) => w.key !== 'Overage'), { key: 'Overage', percent: percent as never, resetsAt: null, status }],
    });
    expect(deriveSpend(emptySource(), headers)?.live).toMatchObject({ left: 0, status: 'rejected', reason: 'org_spend_cap_reached', severity: 'critical' });
    expect(deriveSpend(emptySource(), withOverage('allowed_warning', 78))?.live?.severity).toBe('warning');
    expect(deriveSpend(emptySource(), withOverage('allowed', 0))?.live?.severity).toBe('normal');
  });

  test('live overage carries the reset time the headers gave, and null when they gave none', () => {
    const headers = account(ACC3).headers!;
    const overage = headers.windows.find((w) => w.key === 'Overage')!;
    expect(overage.resetsAt).not.toBeNull();
    expect(deriveSpend(emptySource(), headers)?.live?.resetsAt).toBe(overage.resetsAt);
    const unreset = { ...headers, windows: headers.windows.map((w) => (w.key === 'Overage' ? { ...w, resetsAt: null } : w)) };
    expect(deriveSpend(emptySource(), unreset)?.live?.resetsAt).toBeNull();
  });

  describe('what extra usage means for the account', () => {
    const stateOf = (name: string) => deriveSpend(feedsFrom(usage(name, 'normal'), T0).spend, null)?.poll?.state;

    test('off, a zero cap and a used-up cap are three different states', () => {
      expect(stateOf('anthropic-usage-1.json')).toBe('off');
      expect(stateOf('anthropic-usage-2.json')).toBe('no_budget');
      expect(stateOf('anthropic-usage-3.json')).toBe('cap_used');
    });

    test('a cap spent to its limit or past it is used up, and a cap with room is still a budget', () => {
      const read = usage('anthropic-usage-3.json', 'normal');
      if (read.mode !== 'normal') throw new Error('fixture is a normal read');
      expect(read.spend!.limit!.minor).toBe(10_000);
      const used = (minor: number) => ({ ...read.spend!.used, minor });
      const poll = (change: Partial<Spend>) => deriveSpend({ ...feedsFrom(read, T0).spend, last: { value: { ...read.spend!, ...change }, at: T0 } }, null)?.poll;
      expect(poll({ used: used(10_062) })).toMatchObject({ state: 'cap_used', left: 0, remaining: { minor: 0 }, tone: 'critical' });
      expect(poll({ used: used(10_000) })).toMatchObject({ state: 'cap_used' });
      expect(poll({ used: used(9_999), percent: 99 as never, severity: 'warning' })).toMatchObject({ state: 'budget' });
      expect(poll({ used: used(1_200), percent: 12 as never, severity: 'normal' })).toMatchObject({ state: 'budget', left: 88 });
    });

    test('an enabled account with no cap set still has a budget', () => {
      const read = usage('anthropic-usage-3.json', 'normal');
      if (read.mode !== 'normal') throw new Error('fixture is a normal read');
      const uncapped = { ...feedsFrom(read, T0).spend, last: { value: { ...read.spend!, limit: null }, at: T0 } };
      expect(deriveSpend(uncapped, null)?.poll?.state).toBe('budget');
    });

    test('what is left of the cap is the cap less the spend, never below zero, and nothing without a cap', () => {
      const read = usage('anthropic-usage-3.json', 'normal');
      if (read.mode !== 'normal') throw new Error('fixture is a normal read');
      const poll = (change: Partial<Spend>) => deriveSpend({ ...feedsFrom(read, T0).spend, last: { value: { ...read.spend!, ...change }, at: T0 } }, null)?.poll;
      expect(poll({})).toMatchObject({ left: 0, remaining: { minor: 0, currency: 'USD' } });
      expect(poll({ used: { ...read.spend!.used, minor: 1200 }, percent: 12 as never })).toMatchObject({ left: 88, remaining: { minor: 8800 } });
      expect(poll({ limit: null, percent: null })).toMatchObject({ left: null, remaining: null });
    });

    test('the meter is neutral while the cap has room, warns at a quarter or less left, and is critical once the live overage is rejected', () => {
      const read = usage('anthropic-usage-3.json', 'normal');
      if (read.mode !== 'normal') throw new Error('fixture is a normal read');
      const toneAt = (percent: number, headers: CpaAccount['headers'] = null) => {
        const used = { ...read.spend!.used, minor: percent * 100 };
        const spend = { ...feedsFrom(read, T0).spend, last: { value: { ...read.spend!, used, percent: percent as never, severity: 'normal' as const }, at: T0 } };
        return deriveSpend(spend, headers)?.poll?.tone;
      };
      expect(toneAt(12)).toBe('normal');
      expect(toneAt(74)).toBe('normal');
      expect(toneAt(75)).toBe('warning');
      expect(toneAt(12, { ...account(ACC3).headers!, observedAt: plus(T0, MIN) })).toBe('critical');
    });
  });
});

describe('CPA unreachable', () => {
  const answeredAt = plus(T0, -17_000);
  const answered = snapshot({ now: T0 });
  const failing = (error: SourceError) => ({
    ...answered,
    cpa: { ...answered.cpa, last: { ...answered.cpa.last!, at: answeredAt }, error: { value: error, at: T0 } },
  });

  test('pauses the CPA actions and every account read, and banners the last answer once', () => {
    const d = deriveDeck(failing({ kind: 'cpa_unreachable' }), T0);
    expect(d.cpa).toEqual({ kind: 'down', lastAt: answeredAt });
    expect(d.banners.filter((b) => b.kind === 'cpa_unreachable')).toEqual([{ kind: 'cpa_unreachable', lastAt: answeredAt }]);
    expect(d.accounts).toHaveLength(3);
    for (const a of d.accounts) expect(a.read.paused).toBe(true);
  });

  test('a card carries no stale mark for CPA, and a cooldown can still be cleared once CPA answers', () => {
    const d = deriveDeck(failing({ kind: 'cpa_unreachable' }), T0);
    for (const a of d.accounts) expect(a.freshness.map((f) => f.feed)).not.toContain('cpa');
    expect(d.accounts.map((a) => a.can.clearCooldown)).toEqual([false, false, true]);
  });

  test('the next answer enables the actions again and clears the banner and the paused reads', () => {
    const d = deriveDeck(answered, T0);
    expect(d.cpa).toEqual({ kind: 'up' });
    expect(d.banners.map((b) => b.kind)).not.toContain('cpa_unreachable');
    for (const a of d.accounts) expect(a.read.paused).toBe(false);
  });

  test.each([
    ['CPA answering with an error is down', { kind: 'upstream', status: 500, message: 'boom' }, 'down'],
    ['a rejected management key is the link banner, not an unreachable CPA', { kind: 'link_down' }, 'up'],
  ] as const)('%s', (_label, error, kind) => {
    expect(deriveDeck(failing(error), T0).cpa.kind).toBe(kind);
  });

  test('a CPA that never answered is down with no last answer, and there are no cards to mark', () => {
    const never = { ...answered, cpa: { ...emptySource<readonly CpaAccount[]>(), error: { value: { kind: 'cpa_unreachable' } as const, at: T0 } } };
    const d = deriveDeck(never, T0);
    expect(d.cpa).toEqual({ kind: 'down', lastAt: null });
    expect(d.accounts).toEqual([]);
  });
});

describe('pace toward a quota window, from its latest reading alone', () => {
  const HOUR = 3_600_000;
  const NOW = T0;
  const limit = (kind: string, used: number, resetsInMs: number): Limit => ({ kind, percent: used as Percent, severity: 'normal', resetsAt: plus(NOW, resetsInMs), scopeModel: kind === 'weekly_scoped' ? 'opus' : null, isActive: false });
  const paceOf = (l: Limit) => mergeLimits({ value: [l], at: NOW }, null, NOW).find((v) => v.key.startsWith(l.kind))!.pace;

  test.each([
    ['half used with 40% of the window gone hits the limit before the reset', limit('session', 50, 3 * HOUR), { elapsed: 40, ratio: 1.25, outlook: { kind: 'hits', at: plus(NOW, 2 * HOUR) } }],
    ['used in step with time lasts exactly to the reset', limit('session', 40, 3 * HOUR), { elapsed: 40, ratio: 1, outlook: { kind: 'lasts' } }],
    ['used slower than time lasts', limit('session', 20, 3 * HOUR), { elapsed: 40, ratio: 0.5, outlook: { kind: 'lasts' } }],
    ['nothing used lasts', limit('session', 0, 3 * HOUR), { ratio: 0, outlook: { kind: 'lasts' } }],
    ['a full window is at its limit', limit('session', 100, 3 * HOUR), { outlook: { kind: 'at_limit' } }],
    ['under 5% of the window gone is too early to say', limit('session', 30, 5 * HOUR - 9 * MIN), { elapsed: 3, outlook: { kind: 'too_early' } }],
    ['under 1% gone has no ratio', limit('session', 1, 5 * HOUR - 2 * MIN), { ratio: null, outlook: { kind: 'too_early' } }],
    ['the weekly window opened 7 days before its reset', limit('weekly_all', 20, 3.5 * 24 * HOUR), { startsAt: plus(NOW, -3.5 * 24 * HOUR), elapsed: 50, ratio: 0.4 }],
    ['a scoped weekly window is 7 days too, and 60% at half time hits at 5/6 of it', limit('weekly_scoped', 60, 3.5 * 24 * HOUR), { elapsed: 50, outlook: { kind: 'hits', at: plus(NOW, -3.5 * 24 * HOUR + (7 * 24 * HOUR * 5) / 6) } }],
  ] as const)('%s', (_what, l, want) => {
    expect(paceOf(l)).toMatchObject({ startsAt: plus(l.resetsAt!, -(l.kind === 'session' ? 5 * HOUR : 7 * 24 * HOUR)), endsAt: l.resetsAt, used: l.percent, ...want });
  });

  test('projected is where the window would stand at its reset if the burn so far held', () => {
    expect(paceOf(limit('session', 50, 3 * HOUR))!.projected).toBeCloseTo(125);
    expect(paceOf(limit('session', 20, 3 * HOUR))!.projected).toBeCloseTo(50);
    expect(paceOf(limit('session', 1, 5 * HOUR - 2 * MIN))!.projected).toBeNull();
  });

  test('no pace for a lapsed window, an idle session, an unknown kind, or a window with no reset', () => {
    expect(paceOf(limit('session', 30, -MIN))).toBeNull();
    expect(mergeLimits({ value: [limit('weekly_all', 10, HOUR)], at: NOW }, null, NOW).find((v) => v.key === 'session')).toMatchObject({ phase: 'idle', pace: null });
    expect(paceOf(limit('monthly', 30, HOUR))).toBeNull();
    expect(paceOf({ ...limit('session', 30, HOUR), resetsAt: null })).toBeNull();
  });

  test('a header reading gets pace too: 5h maps to the session window', () => {
    const headers = { observedAt: NOW, status: null, resetsAt: null, windows: [{ key: '5h', percent: 50 as Percent, resetsAt: plus(NOW, 3 * HOUR), status: null }], overageDisabledReason: null };
    expect(mergeLimits(null, headers, NOW)[0]!.pace).toMatchObject({ startsAt: plus(NOW, -2 * HOUR), outlook: { kind: 'hits', at: plus(NOW, 2 * HOUR) } });
  });
});
