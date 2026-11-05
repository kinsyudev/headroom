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
  type Sample,
  type Snapshot,
  type Source,
  type SourceError,
} from '../src/shared/domain';
import type { OfferState } from '../src/shared/view';
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
    expect(d.overview.serving.map((s) => [s.account, s.why, s.takesNext])).toEqual([
      [ACC1, 'fill_first_target', true],
      [ACC2, 'affinity', false],
    ]);
    expect(d.overview.target?.account).toBe(ACC1);
  });

  test('a serving account takes the next new session only when it is the predicted target', () => {
    const seen = (account: typeof ACC1) => deck({ serving: [{ account, lastAt: plus(T0, -10_000), recent: 3 }] }).overview;
    expect(seen(ACC1).serving.map((s) => [s.account, s.takesNext])).toEqual([[ACC1, true]]);
    expect(seen(ACC2).serving.map((s) => [s.account, s.takesNext])).toEqual([[ACC2, false]]);
    expect(seen(ACC2).target?.account).toBe(ACC1);
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

  test('a poll without a session limit and older 5h headers stays idle and keeps the header value, with nothing drawn to differ from', () => {
    const m = mergeLimits(pollOf('anthropic-usage-1.json', T0), account(ACC1).headers, T0);
    expect(m[0]).toMatchObject({ key: 'session', phase: 'idle', percent: null, other: { kind: 'headers', percent: 17, differs: false } });
  });

  describe('which readings differ enough to mark', () => {
    const headerSession = (percent: number): CpaAccount['headers'] => {
      const h = account(ACC1).headers!;
      return { ...h, windows: h.windows.map((w) => (w.key === '5h' ? { ...w, percent: percent as never } : w)) };
    };
    const differs = (headerPercent: number) => mergeLimits(pollOf('anthropic-usage-2.json', T0), headerSession(headerPercent), T0)[0]!.other?.differs;

    test.each([
      [10, true],
      [11, false],
      [12, false],
      [13, false],
      [14, true],
      [17, true],
    ])('the poll draws 12% and the headers say %p%%: marked is %p', (headers, marked) => {
      expect(differs(headers)).toBe(marked);
    });

    test('a lapsed row has no drawn percent, so its other reading is never marked', () => {
      const older = { ...headerSession(40)!, observedAt: plus(T0, -MIN) };
      const m = mergeLimits(pollOf('anthropic-usage-3.json', T0), { ...older, windows: [{ key: '5h', percent: 40 as never, resetsAt: at('2026-11-04T19:20:00Z'), status: 'allowed' }] }, AFTER_COOLDOWN);
      expect(m[0]).toMatchObject({ key: 'session', phase: 'lapsed', other: { percent: 40, differs: false } });
    });
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
  const offersOf = (feeds: AccountFeeds, atWall = true, claims: ClaimRecord[] = []) => deriveOffers(ACC3, feeds, atWall, claims, T0, limitsOf(feeds)).offers;
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

  describe('naming a reset once and saying what it clears once', () => {
    const withGrants = (grants: CedarEmber['grants']): AccountFeeds => {
      const f = feedsFrom(synthetic, T0);
      return { ...f, cedar: { ...f.cedar, last: { value: c({ grants }), at: T0 } } };
    };
    const panel = (feeds: AccountFeeds) => {
      const a = deriveDeck(snapshot({ feeds: { [ACC3]: feeds } }), T0).accounts.find((x) => x.id === ACC3)!;
      return { offersClear: a.offersClear, rows: Object.fromEntries(a.offers.map((o) => [o.program, [o.name, ...o.terms]])) };
    };
    const eachRowSaysItsOwn = (bonus: string[]) => ({
      offersClear: null,
      rows: { juniper_tide: ['Weekly allowance', 'clears the session limit', 'once a week'], cedar_ember: ['Bonus grant', ...bonus] },
    });

    test('resets that clear the same limit say it once, and each row keeps its one name and what sets it apart', () => {
      expect(panel(feedsFrom(synthetic, T0))).toEqual({
        offersClear: 'the session limit',
        rows: { juniper_tide: ['Weekly allowance', 'once a week'], cedar_ember: ['Bonus grant'] },
      });
    });

    test.each([
      ['a weekly bonus', ['seven_day'], 'clears the weekly limit'],
      ['a bonus clearing both', ['five_hour', 'seven_day'], 'clears the session and weekly limits'],
    ] as const)('%s clears something else, so each row names what it clears', (_label, clears, bonus) => {
      expect(panel(withGrants([{ ...grant, clears: [...clears] }]))).toEqual(eachRowSaysItsOwn([bonus]));
    });

    test('a bonus naming nothing claims nothing, and the weekly allowance still says what it clears', () => {
      expect(panel(withGrants([{ ...grant, clears: [] }]))).toEqual(eachRowSaysItsOwn([]));
      expect(panel(feedsFrom(usage('anthropic-usage-at-wall-1.json', 'wall'), T0))).toEqual(eachRowSaysItsOwn([]));
    });

    test('with no usable grant the panel still says what the grants clear', () => {
      expect(panel(withGrants([{ ...grant, resetsLeft: 0 }])).offersClear).toBe('the session limit');
    });

    test('the overview and the card name a claimable reset identically, and the overview groups them by account', () => {
      const d = deriveDeck(snapshot({ feeds: { [ACC3]: feedsFrom(synthetic, T0) } }), T0);
      const cardNames = d.accounts.find((a) => a.id === ACC3)!.offers.map((o) => o.name);
      expect(d.overview.claimable).toEqual([
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

  describe('what a claim saves', () => {
    const selfResetsOf = (feeds: AccountFeeds, program: ClaimRecord['program']) => offersOf(feeds).find((o) => o.program === program)!.selfResets;
    const sessionAt = at('2026-11-04T14:20:00.412Z');
    const weeklyAt = at('2026-11-04T19:00:00.412Z');

    test('the weekly allowance names when the session limit would reset on its own', () => {
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
      expect(quiet(feedsFrom(noGrants, T0), false)).toEqual(['none to claim', 'weekly reset offered at limit', 'no grants']);
      expect(quiet(enrolledNowhere())).toEqual(['none to claim', 'weekly reset not enrolled', 'reset grants not enrolled']);
    });

    test('a reason without a short form falls back to its plain-words explanation', () => {
      const controlArm = { ...noGrants, juniper: j({ arm: 'control' }) };
      expect(quiet(feedsFrom(controlArm, T0))).toEqual(['none to claim', 'in the experiment, but in the arm that is not offered resets', 'no grants']);
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
      expect(card(ACC1).quietOffers?.[0]).toBe('none to claim');
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

describe('headroom and next reset', () => {
  test('session headroom is min(session left, weekly left); idle sessions count as full', () => {
    const feeds = {
      [ACC1]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
      [ACC2]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
      [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
    };
    const d = deriveDeck(snapshot({ feeds }), T0);
    const account2 = { account: ACC2, email: 'account2@example.com', left: 0.99 };
    expect(d.overview.headroom.session).toEqual({ value: 1.72, of: 3, unknown: 0, percent: 57, most: account2 });
    expect(d.overview.headroom.weekly).toEqual({ value: 2.12, of: 3, unknown: 0, percent: 71, most: account2 });
    expect(d.overview.nextReset).toMatchObject({ account: ACC3, label: 'Session', at: at('2026-11-04T14:20:00.412Z') });
  });

  test('an account with no limits data counts as unknown, not as 0 or 100', () => {
    const noHeaders = cpaAccounts().map((a): CpaAccount => (a.id === ACC2 ? { ...a, headers: null } : a));
    const d = deriveDeck(snapshot({ accounts: noHeaders }), T0);
    const weekly = d.overview.headroom.weekly;
    expect(weekly.unknown).toBe(1);
    expect(weekly.of).toBe(3);
    expect(weekly.most).toEqual({ account: ACC1, email: 'account1@example.com', left: 0.73 });
    expect(weekly.percent).toBe(57);
  });

  test('with no account read yet, no share and no account with the most room', () => {
    const blind = cpaAccounts().map((a): CpaAccount => ({ ...a, headers: null }));
    expect(deriveDeck(snapshot({ accounts: blind }), T0).overview.headroom.session).toEqual({ value: 0, of: 3, unknown: 3, percent: null, most: null });
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
    const keys = columns(feeds).map((c) => c.key);
    expect(keys.slice(0, 2)).toEqual(['session', 'weekly_all']);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of deriveDeck(snapshot({ feeds }), T0).accounts) for (const l of a.limits) expect(keys).toContain(l.key);
  });

  test('a scoped window only one account reports still gets its column, labelled as the card labels it', () => {
    const f = feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0);
    const opus: Limit = { kind: 'weekly_scoped', scopeModel: 'Opus', percent: 40 as never, severity: 'normal', resetsAt: plus(T0, 60 * MIN), isActive: false };
    const withOpus = { ...f, limits: { ...f.limits, last: { value: [...f.limits.last!.value, opus], at: T0 } } };
    expect(columns({ [ACC1]: withOpus, [ACC2]: f })).toContainEqual({ key: 'weekly_scoped:Opus', label: 'Weekly · Opus' });
  });

  test('no account read yet and no traffic: no columns', () => {
    expect(columns({}, cpaAccounts().map((a): CpaAccount => ({ ...a, headers: null })))).toEqual([]);
  });
});

describe('the next reset and the unblock it may repeat', () => {
  const feeds = {
    [ACC1]: feedsFrom(usage('anthropic-usage-2.json', 'normal'), T0),
    [ACC2]: feedsFrom(usage('anthropic-usage-1.json', 'normal'), T0),
    [ACC3]: feedsFrom(usage('anthropic-usage-3.json', 'normal'), T0),
  };
  const overview = (change: (a: CpaAccount) => CpaAccount) => deriveDeck(snapshot({ accounts: cpaAccounts().map(change), feeds }), T0).overview;
  const unblock = (a: CpaAccount, retryAt: Instant): CpaAccount => ({
    ...a,
    cooldowns: a.cooldowns.map((c) => ({ ...c, retryAt })),
    nextRetryAfter: retryAt,
    unavailable: true,
  });
  const quiet = (a: CpaAccount): CpaAccount => ({ ...a, cooldowns: [], unavailable: false, nextRetryAfter: null });

  test('the same account unblocking within a minute of its reset is said once, on the reset', () => {
    const o = overview((a) => a);
    expect(o.nextReset).toMatchObject({ account: ACC3, label: 'Session', at: at('2026-11-04T14:20:00.412Z'), unblocks: true });
    expect(o.nextUnblock).toBeNull();
  });

  test('a minute boundary between the two clock times does not split them', () => {
    const o = overview((a) => (a.id === ACC3 ? unblock(a, at('2026-11-04T14:19:50.000Z')) : a));
    expect(o.nextReset).toMatchObject({ account: ACC3, unblocks: true });
    expect(o.nextUnblock).toBeNull();
  });

  test.each([
    ['half an hour after', '2026-11-04T14:50:17.000Z'],
    ['70 s before', '2026-11-04T14:18:50.000Z'],
  ])('an unblock %s the reset stays its own line', (_label, when) => {
    const o = overview((a) => (a.id === ACC3 ? unblock(a, at(when)) : a));
    expect(o.nextReset).toMatchObject({ account: ACC3, unblocks: false });
    expect(o.nextUnblock).toEqual({ account: ACC3, email: 'account3@example.com', at: at(when) });
  });

  test("another account's unblock at the same time is a different event and stays its own line", () => {
    const o = overview((a) => (a.id === ACC3 ? quiet(a) : a.id === ACC2 ? unblock(a, at('2026-11-04T14:20:30.000Z')) : a));
    expect(o.nextReset).toMatchObject({ account: ACC3, unblocks: false });
    expect(o.nextUnblock).toEqual({ account: ACC2, email: 'account2@example.com', at: at('2026-11-04T14:20:30.000Z') });
  });

  test('with no blocked account the reset says nothing about unblocking', () => {
    const o = overview(quiet);
    expect(o.nextReset?.unblocks).toBe(false);
    expect(o.nextUnblock).toBeNull();
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

    test('a spend-cap message on an account with its session used up names the session window, and keeps the message as the cause', () => {
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
    ['no message: the cooldown code in plain words', null, 'credential_quota', 'Quota used up'],
    ['an unmapped message with only an unknown code is shown as it came', 'Something new broke.', 'unknown', 'Something new broke.'],
    ['no message and an unknown code: said so', null, 'unknown', 'Reason unknown'],
  ] as const)('%s', (_label, statusMessage, reason, cause) => {
    expect(trouble((a) => ({ ...a, statusMessage, cooldowns: [credential(reason, END)] }))?.cause).toBe(cause);
  });

  test('the account-wide reason leads over a model reason', () => {
    const t = trouble((a) => ({ ...a, statusMessage: null, cooldowns: [model('claude-opus-5-5', 'unauthorized', END), credential('credential_quota', END)] }));
    expect(t?.cause).toBe('Quota used up');
  });

  test('one model cooling down on an account that still routes is named, and the account is not called blocked', () => {
    const t = trouble((a) => ({ ...a, statusMessage: null, unavailable: false, nextRetryAfter: null, cooldowns: [model('claude-opus-5-5', 'quota', END)] }));
    expect(t).toMatchObject({ cause: 'Quota used up', holds: [{ what: 'opus-5-5 cooling down', until: END }] });
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
    expect(deriveSpend(emptySource(), headers)?.live).toMatchObject({ percent: 101, status: 'rejected', reason: 'org_spend_cap_reached', severity: 'critical' });
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

    test('off, a zero cap and a cap with room are three different states', () => {
      expect(stateOf('anthropic-usage-1.json')).toBe('off');
      expect(stateOf('anthropic-usage-2.json')).toBe('no_budget');
      expect(stateOf('anthropic-usage-3.json')).toBe('budget');
    });

    test('an enabled account with no cap set still has a budget', () => {
      const read = usage('anthropic-usage-3.json', 'normal');
      if (read.mode !== 'normal') throw new Error('fixture is a normal read');
      const uncapped = { ...feedsFrom(read, T0).spend, last: { value: { ...read.spend!, limit: null }, at: T0 } };
      expect(deriveSpend(uncapped, null)?.poll?.state).toBe('budget');
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
