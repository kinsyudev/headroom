import { describe, expect, test } from 'bun:test';
import { parseAuthFiles } from '../src/server/cpa';
import { parseProfile, parseUsage } from '../src/server/anthropic';
import { epochSecondsToInstant, fractionToPercent, parseInstant } from '../src/shared/domain';
import { ACC1, ACC2, ACC3, account, at, cpaAccounts, fixture, usage } from './support';

describe('boundary conversions', () => {
  test.each([
    ['2026-11-04T13:25:39.44912+01:00', '2026-11-04T12:25:39.449Z'],
    ['2026-11-04T14:20:17.000592Z', '2026-11-04T14:20:17.000Z'],
    ['2026-11-04 20:04:26.66+08:00', '2026-11-04T12:04:26.660Z'],
    ['2026-11-10T09:00:00.634182+00:00', '2026-11-10T09:00:00.634Z'],
  ])('parseInstant(%s) is %s', (text, iso) => {
    expect(parseInstant(text)).toBe(at(iso));
  });

  test('garbage and blanks parse to null', () => {
    expect(parseInstant('soon')).toBeNull();
    expect(parseInstant('')).toBeNull();
    expect(epochSecondsToInstant('')).toBeNull();
    expect(fractionToPercent(undefined)).toBeNull();
  });

  test('header fractions become percents without float noise', () => {
    expect(fractionToPercent('0.17')).toBe(17 as never);
    expect(fractionToPercent('1.01')).toBe(101 as never);
    expect(epochSecondsToInstant('1793811600')).toBe(at('2026-11-04T17:00:00Z'));
  });
});

describe('CPA auth-files fixture', () => {
  const accounts = cpaAccounts();

  test('keeps the three Claude credentials, keyed by auth_index', () => {
    expect(accounts.map((a) => [a.id, a.email, a.priority])).toEqual([
      [ACC2, 'account2@example.com', 10],
      [ACC1, 'account1@example.com', 50],
      [ACC3, 'account3@example.com', 50],
    ]);
  });

  test('account3: blocked by a credential_quota cooldown, with the spend-limit message unwrapped', () => {
    const a = account(ACC3, accounts);
    expect(a.status).toBe('error');
    expect(a.unavailable).toBe(true);
    expect(a.nextRetryAfter).toBe(at('2026-11-04T14:20:17.000Z'));
    expect(a.cooldowns[0]).toEqual({ model: null, reason: 'credential_quota', retryAt: at('2026-11-04T14:20:17.000Z'), httpStatus: null });
    expect(a.cooldowns.find((c) => c.model === 'claude-opus-5-5')).toMatchObject({ reason: 'quota', httpStatus: 429 });
    expect(a.statusMessage).toBe("This request would exceed your account's monthly spend limit. Please try again later.");
  });

  test('passive headers: account1 at 17% session and 27% weekly, account3 rejected with overage at 101%', () => {
    const h1 = account(ACC1, accounts).headers!;
    expect(h1.observedAt).toBe(at('2026-11-04T12:26:12.209Z'));
    expect(h1.status).toBe('allowed');
    expect(h1.windows.find((w) => w.key === '5h')).toEqual({ key: '5h', percent: 17 as never, resetsAt: at('2026-11-04T17:00:00Z'), status: 'allowed' });
    expect(h1.windows.find((w) => w.key === '7d')?.percent).toBe(27 as never);

    const h3 = account(ACC3, accounts).headers!;
    expect(h3.status).toBe('rejected');
    expect(h3.resetsAt).toBe(at('2026-11-04T14:20:00Z'));
    expect(h3.windows.find((w) => w.key === 'Overage')).toMatchObject({ percent: 101, status: 'rejected' });
    expect(h3.overageDisabledReason).toBe('org_spend_cap_reached');
  });

  test('recent_requests anchor to observed_at: 20 ten-minute buckets ending at 12:20Z (13:20 CPA local)', () => {
    const act = account(ACC2, accounts).activity;
    expect(act).toHaveLength(20);
    expect(act.at(-1)).toEqual({ start: at('2026-11-04T12:20:00Z'), success: 2, failed: 0 });
    expect(act[0]!.start).toBe(at('2026-11-04T09:10:00Z'));
    expect(act.at(-3)).toEqual({ start: at('2026-11-04T12:00:00Z'), success: 25, failed: 1 });
  });

  test('an account with no traffic since CPA started has quota {signals: {}} and parses with no headers', () => {
    const json = fixture('cpa-auth-files.json') as { files: Record<string, unknown>[] };
    json.files[0]!.quota = { signals: {} };
    const parsed = parseAuthFiles(json);
    expect(parsed.accounts).toHaveLength(3);
    expect(account(ACC2, parsed.accounts).headers).toBeNull();
  });

  test('other providers never block the Claude accounts, whatever their shape', () => {
    const json = fixture('cpa-auth-files.json') as { files: Record<string, unknown>[] };
    json.files.push({ provider: 'codex', auth_index: 42, quota: { weird: true } });
    expect(parseAuthFiles(json).accounts.map((a) => a.id)).toEqual([ACC2, ACC1, ACC3]);
  });

  test('the file name stays private but resolvable', () => {
    const { names } = parseAuthFiles(fixture('cpa-auth-files.json'));
    expect(names.get(ACC2)).toBe('claude-793879e9-account2@example.com.json');
    expect(JSON.stringify(accounts)).not.toContain('.json');
  });
});

describe('Anthropic usage fixtures', () => {
  test('normal read, fixture 1: no session limit, weekly 1%, scoped Fable 0%, spend off', () => {
    const r = usage('anthropic-usage-1.json', 'normal');
    if (r.mode !== 'normal') throw new Error('mode');
    expect(r.limits.map((l): unknown[] => [l.kind, l.scopeModel, l.percent, l.isActive])).toEqual([
      ['weekly_all', null, 1, true],
      ['weekly_scoped', 'Fable', 0, false],
    ]);
    expect(r.spend).toMatchObject({ enabled: false, used: { minor: 0, currency: 'USD', exponent: 2 }, limit: null });
    expect(r.cedar).toBeNull();
  });

  test('normal read, fixture 3: session 100% critical and spend over its cap', () => {
    const r = usage('anthropic-usage-3.json', 'normal');
    if (r.mode !== 'normal') throw new Error('mode');
    expect(r.limits[0]).toMatchObject({ kind: 'session', percent: 100, severity: 'critical', resetsAt: at('2026-11-04T14:20:00.412Z'), isActive: true });
    expect(r.spend).toMatchObject({ enabled: true, used: { minor: 10062 }, limit: { minor: 10000 }, severity: 'critical' });
  });

  test('wall read, fixture 1: juniper not_at_wall, cedar no_grant', () => {
    const r = usage('anthropic-usage-at-wall-1.json', 'wall');
    if (r.mode !== 'wall') throw new Error('mode');
    expect(r.juniper).toMatchObject({ eligible: false, ineligibleReason: 'not_at_wall', arm: null, available: false });
    expect(r.cedar).toMatchObject({ eligible: false, ineligibleReason: 'no_grant', grants: [] });
    expect('spend' in r).toBe(false);
  });

  test('wall read, fixtures 2 and 3: juniper null means not enrolled', () => {
    for (const n of [2, 3]) {
      const r = usage(`anthropic-usage-at-wall-${n}.json`, 'wall');
      expect(r.mode === 'wall' && r.juniper).toBeNull();
    }
  });

  test('synthetic claimable wall read: juniper in the reset arm and one usable grant', () => {
    const r = usage('synthetic-usage-at-wall-claimable.json', 'wall');
    if (r.mode !== 'wall') throw new Error('mode');
    expect(r.juniper).toMatchObject({ eligible: true, arm: 'reset', available: true });
    expect(r.cedar?.nextGrantId).toBe('grant_example_1' as never);
    expect(r.cedar?.grants[0]).toMatchObject({ resetsLeft: 2, resetsTotal: 3, clears: ['five_hour'], usableNow: true, paused: false });
  });

  test('a body without limits[] is rejected at the boundary', () => {
    expect(() => parseUsage({ five_hour: null }, 'normal')).toThrow();
  });

  test('profiles: plan, tier and org uuid', () => {
    expect(parseProfile(fixture('anthropic-profile-1.json'))).toEqual({
      email: 'account2@example.com',
      orgUuid: '00000000-0000-4000-8000-0536290a9f21',
      orgName: 'Example Org',
      orgType: 'claude_max',
      rateLimitTier: 'default_claude_max_20x',
      planLabel: 'Ultra plan',
    });
    expect(parseProfile(fixture('anthropic-profile-2.json'))).toMatchObject({ orgType: 'claude_team', rateLimitTier: 'default_claude_max_5x' });
  });
});
