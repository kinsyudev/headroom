import { expect, test } from 'bun:test';
import { ANTHROPIC_GAP_MS, CLAIM_TIMEOUT_MS, READ_TIMEOUT_MS } from '../src/server/anthropic';
import { FOLLOWUP_GAP_MS, FOLLOWUP_TRIES } from '../src/server/claims';
import { MANAGEMENT_TIMEOUT_MS } from '../src/server/cpa';
import { BUN_MAX_IDLE_TIMEOUT_S } from '../src/server/http';
import { CLAUDE_CODE_CLAIM_TIMEOUT_MS, SETTLE_LAG_MS } from '../src/shared/derive';

test('the HTTP idle timeout outlasts one claim request: fresh wall read, claim, then the cooldown clears', () => {
  const freshWallRead = ANTHROPIC_GAP_MS + READ_TIMEOUT_MS;
  const claim = ANTHROPIC_GAP_MS + CLAIM_TIMEOUT_MS;
  const cooldownClears = FOLLOWUP_TRIES * MANAGEMENT_TIMEOUT_MS + (FOLLOWUP_TRIES - 1) * FOLLOWUP_GAP_MS;
  expect(BUN_MAX_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(freshWallRead + claim + cooldownClears);
});

test("Headroom's wait on CPA for a claim outlasts Claude Code's own claim timeout", () => {
  expect(CLAIM_TIMEOUT_MS).toBeGreaterThan(CLAUDE_CODE_CLAIM_TIMEOUT_MS);
});

test('a claimed program is held for at least a minute and for longer than Claude Code waits on the claim', () => {
  expect(SETTLE_LAG_MS).toBeGreaterThanOrEqual(60_000);
  expect(SETTLE_LAG_MS).toBeGreaterThan(CLAUDE_CODE_CLAIM_TIMEOUT_MS);
});
