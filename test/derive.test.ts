/**
 * deriveDeck against the real CPA fixture (parsed through cpa.parseAuthFiles) plus hand-built
 * Anthropic samples written from docs/upstream.md. All six captured usage and at-wall fixtures are
 * rate_limit_error bodies, so they're used for the backoff tests in observer.test.ts, not here.
 * now = 2026-11-04T12:26:12Z (the fixture's observed_at).
 */
import { describe, test } from 'bun:test';

describe('routing (fixture)', () => {
  test.todo('account1 (prio 50, available) is the fill-first target');
  test.todo('account3 (prio 50, unavailable, credential cooldown to 14:20Z) is blocked until 14:20Z, not target');
  test.todo('account2 (prio 10) observed 13:25:39+01:00 → serving with why=affinity, not standby');
  test.todo('at now = 14:20:18Z the cooldown and next_retry_after have passed → account3 eligible and in the target tier, though status is still error');
});

describe('limits merge', () => {
  test.todo('headers only: account1 Session 17% and Weekly 27%, both source=headers, resets from the epoch-second headers');
  test.todo('poll older than headers: headers drawn, poll kept as `other`');
  test.todo('poll newer than headers: poll drawn, headers kept as `other`');
  test.todo('resetsAt in the past and no newer observation → rolled, percent null');
  test.todo('header status rejected → severity critical even when the poll said warning');
});

describe('offers', () => {
  test.todo('juniper eligible, arm=reset, available → claimable');
  test.todo('juniper eligible, arm=reset, !available, nextAvailableAt in future → waiting(until)');
  test.todo('juniper eligible, arm=control → ineligible control_arm');
  test.todo('juniper !eligible not_at_wall → held');
  test.todo('juniper null → not_enrolled');
  test.todo('cedar: next_grant_id usable → claimable with that grant; else first usable grant');
  test.todo('cedar: all grants resets_left 0 → ineligible exhausted');
  test.todo('cedar: cooldown_until in future → waiting');
  test.todo('open claim (sending or in_doubt) on that program → in_flight regardless of poll data');
  test.todo('programs never polled → unknown never_polled; error only → unknown failing');
});

describe('make primary', () => {
  test.todo('target 10, others 50/50 → priority 60');
  test.todo('target already strictly highest → priority null, enable false (no-op on second click)');
  test.todo('disabled target → enable true');
});

describe('headroom', () => {
  test.todo('session headroom uses min(session left, weekly left) per enabled account');
  test.todo('accounts with no limits data count in `unknown`, not as 0 or 100');
});
