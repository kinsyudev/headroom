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
    expect(view(deck({ accounts }), ACC1).routing.stepTo).toEqual(stepTo);
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
    const cedarOffer = deriveOffers(ACC3, feedsFrom(synthetic, T0), true, [], T0).find((o) => o.program === 'cedar_ember')!;
    expect(cedarOffer.grants[0]).toMatchObject({ clears: ['five_hour'], clearsText: 'the session (5h) limit' });
  });

  test('the unknown-outcome banner names the program by its label', () => {
    const maybeSent = claim({ kind: 'maybe_sent', at: T0, why: 'timed out' });
    const d = deriveDeck(snapshot({ claims: [maybeSent], feeds: { [ACC3]: feedsFrom(synthetic, T0) } }), T0);
    expect(d.banners).toContainEqual({ kind: 'claim_unknown', claim: 'c1' as ClaimId, email: 'account3@example.com', program: 'juniper_tide', label: 'Weekly session reset' });
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
});

describe('CPA unreachable', () => {
  const answeredAt = plus(T0, -17_000);
  const answered = snapshot({ now: T0 });
  const failing = (error: SourceError) => ({
    ...answered,
    cpa: { ...answered.cpa, last: { ...answered.cpa.last!, at: answeredAt }, error: { value: error, at: T0 } },
  });

  test('pauses the CPA actions, banners the last answer and marks every card stale', () => {
    const d = deriveDeck(failing({ kind: 'cpa_unreachable' }), T0);
    expect(d.cpa).toEqual({ kind: 'down', lastAt: answeredAt });
    expect(d.banners[0]).toEqual({ kind: 'cpa_unreachable', lastAt: answeredAt });
    expect(d.accounts).toHaveLength(3);
    for (const a of d.accounts) expect(a.freshness[0]).toMatchObject({ feed: 'cpa', state: 'stale', ageMs: 17_000 });
  });

  test('the next answer enables the actions again and clears the banner and the stale marks', () => {
    const d = deriveDeck(answered, T0);
    expect(d.cpa).toEqual({ kind: 'up' });
    expect(d.banners.map((b) => b.kind)).not.toContain('cpa_unreachable');
    for (const a of d.accounts) expect(a.freshness.map((f) => f.feed)).not.toContain('cpa');
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
