import { describe, expect, test } from 'bun:test';
import { INELIGIBLE_EXPLAIN } from '../src/shared/derive';
import type { ClaimId, ClaimRecord, Instant } from '../src/shared/domain';
import { claimText, money, reasonText, reasonTitle } from '../src/ui/format';

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
