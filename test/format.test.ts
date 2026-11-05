import { describe, expect, test } from 'bun:test';
import { INELIGIBLE_EXPLAIN } from '../src/shared/derive';
import type { ClaimId, ClaimRecord, Instant } from '../src/shared/domain';
import { bucketText, changeText, claimText, compact, count, foldedPaceSays, hourText, modelName, money, reasonText, reasonTitle, seconds, shortName, share, stamp, weekdayName } from '../src/ui/format';

describe('a folded quota pace line', () => {
  test.each([
    [1, 0, 'Lasts to the reset'],
    [2, 0, 'Both last to the reset'],
    [3, 0, 'All 3 last to the reset'],
    [0, 1, 'Too early to say'],
    [0, 2, 'Both too early to say'],
    [1, 1, '1 lasts to the reset, 1 too early to say'],
    [2, 1, '2 last to the reset, 1 too early to say'],
  ])('%i that last and %i too early says "%s"', (lasts, early, says) => {
    expect(foldedPaceSays(lasts, early)).toBe(says);
  });
});

describe('amounts', () => {
  test('a whole amount drops its cents and any other amount keeps them', () => {
    const usd = (minor: number) => ({ minor, currency: 'USD', exponent: 2 });
    expect(money(usd(10_000))).toBe('$100');
    expect(money(usd(10_062))).toBe('$100.62');
    expect(money(usd(8_766))).toBe('$87.66');
    expect(money(usd(0))).toBe('$0');
  });
});

describe('raw codes in plain words', () => {
  test.each([
    ['credential_quota', 'no quota left'],
    ['quota', 'no quota left'],
    ['org_spend_cap_reached', 'monthly spend cap reached'],
    ['group_zero_credit_limit', 'no extra-usage credit'],
  ])('%s reads %s', (code, phrase) => {
    expect(reasonText(code)).toBe(phrase);
    expect(reasonTitle(code)).toBe(`${phrase} (${code})`);
  });

  test('a code with no known phrase keeps its raw form', () => {
    expect(reasonText('something_new')).toBe('something_new');
    expect(reasonTitle('something_new')).toBe('something_new');
  });

  const settled = (outcome: Extract<ClaimRecord['state'], { kind: 'settled' }>['outcome']): ClaimRecord => ({
    id: 'c1' as ClaimId,
    account: 'a' as ClaimRecord['account'],
    program: 'juniper_tide',
    grant: null,
    startedAt: 0 as Instant,
    state: { kind: 'settled', at: 0 as Instant, outcome, followup: 'not_needed' },
  });

  test('a claim refused as ineligible explains the reason instead of printing the code', () => {
    const refused = (reason: string) => claimText(settled({ result: 'ineligible', reason, resetsLeft: null, cleared: [], nextAvailableAt: null }));
    expect(refused('weekly_limit')).toBe(`Anthropic answered ineligible. ${INELIGIBLE_EXPLAIN.weekly_limit} Nothing consumed.`);
    expect(refused('brand_new_code')).toBe('Anthropic answered ineligible. Reason: brand_new_code. Nothing consumed.');
  });
});

describe('figures on the usage page', () => {
  test.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['gpt-9', 'gpt-9'],
  ])('model %s reads %s', (id, name) => {
    expect(modelName(id)).toBe(name);
  });

  test('a share keeps a decimal where it is small or near the whole, and reads zero and the whole plainly', () => {
    expect(share(0)).toBe('0%');
    expect(share(0.0004)).toBe('<0.1%');
    expect(share(0.0123)).toBe('1.2%');
    expect(share(0.866)).toBe('87%');
    expect(share(0.966)).toBe('96.6%');
    expect(share(1)).toBe('100%');
    expect(share(null)).toBe('—');
  });

  test('a compact number keeps one decimal above a thousand, so 2.0M reads beside 1.4M', () => {
    expect(compact(2_000_000)).toBe('2.0M');
    expect(compact(1_400_000)).toBe('1.4M');
    expect(compact(348_100)).toBe('348.1K');
    expect(compact(1_000)).toBe('1.0K');
    expect(compact(999_950)).toBe('1.0M');
    expect(compact(640)).toBe('640');
    expect(compact(0)).toBe('0');
    expect(count(20_000)).toBe('20.0K');
  });

  test('an account goes by the part of its email before the @', () => {
    expect(shortName('account1@example.com')).toBe('account1');
    expect(shortName('no-at-sign')).toBe('no-at-sign');
  });

  test('a moment is dated like a chart axis, with the day before the time', () => {
    const now = new Date(2026, 10, 12, 9, 0).getTime();
    expect(stamp(new Date(2026, 10, 4, 19, 25).getTime(), now)).toBe('Nov 4 19:25');
    expect(stamp(new Date(2026, 10, 5, 0, 5).getTime(), now)).toBe('Nov 5 00:05');
  });

  test('a moment on the current day says today, and the day before it never reads as a weekday', () => {
    const now = new Date(2026, 10, 5, 9, 0).getTime();
    expect(stamp(new Date(2026, 10, 5, 0, 5).getTime(), now)).toBe('today 00:05');
    expect(stamp(new Date(2026, 10, 5, 18, 40).getTime(), now)).toBe('today 18:40');
    expect(stamp(new Date(2026, 10, 4, 19, 25).getTime(), now)).toBe('Nov 4 19:25');
    expect(stamp(new Date(2026, 10, 6, 3, 0).getTime(), now)).toBe('Nov 6 03:00');
  });

  test('counts, times and changes', () => {
    expect(count(1_284)).toBe('1,284');
    expect(count(30_242)).toBe('30.2K');
    expect(seconds(1_130)).toBe('1.1 s');
    expect(seconds(21_400)).toBe('21 s');
    expect(seconds(null)).toBe('—');
    expect(changeText(0.193)).toBe('19%');
    expect(changeText(-0.004)).toBe('0.4%');
    expect(changeText(null)).toBe('—');
    expect(weekdayName(0)).toBe('Monday');
    expect(weekdayName(6, 'short')).toBe('Sun');
    expect(hourText(7)).toBe('07:00');
    expect(hourText(24)).toBe('00:00');
  });

  test('the bucket still filling says now, and a day bucket names its weekday', () => {
    const t = bucketText('day', Date.parse('2026-11-04T12:00:00Z'));
    const day = { start: Date.parse('2026-11-02T00:00:00'), end: Date.parse('2026-11-03T00:00:00'), partial: false };
    expect(t.label({ ...day, partial: true })).toBe('now');
    expect(t.title({ ...day, partial: true })).toContain('in progress');
    expect(t.span(day)).toContain('Mon');
  });
});
