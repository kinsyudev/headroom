import { expect, test } from 'bun:test';
import { ANTHROPIC_GAP_MS, CLAIM_TIMEOUT_MS, READ_TIMEOUT_MS } from '../src/server/anthropic';
import { FOLLOWUP_GAP_MS, FOLLOWUP_TRIES } from '../src/server/claims';
import { MANAGEMENT_TIMEOUT_MS } from '../src/server/cpa';
import { BUN_MAX_IDLE_TIMEOUT_S } from '../src/server/http';

test('the HTTP idle timeout outlasts one claim request: fresh wall read, claim, then the cooldown clears', () => {
  const freshWallRead = ANTHROPIC_GAP_MS + READ_TIMEOUT_MS;
  const claim = ANTHROPIC_GAP_MS + CLAIM_TIMEOUT_MS;
  const cooldownClears = FOLLOWUP_TRIES * MANAGEMENT_TIMEOUT_MS + (FOLLOWUP_TRIES - 1) * FOLLOWUP_GAP_MS;
  expect(BUN_MAX_IDLE_TIMEOUT_S * 1000).toBeGreaterThan(freshWallRead + claim + cooldownClears);
});
