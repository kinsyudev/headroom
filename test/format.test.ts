import { describe, expect, test } from 'bun:test';
import { INELIGIBLE_EXPLAIN } from '../src/shared/derive';
import type { ClaimId, ClaimRecord, Instant } from '../src/shared/domain';
import { bucketText, changeText, claimText, count, hourText, modelName, money, reasonText, reasonTitle, seconds, share, weekdayName } from '../src/ui/format';

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
