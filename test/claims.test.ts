/**
 * The reset-claim state machine, against a real deck.db in a temp dir and a fake Anthropic whose
 * claimReset is scripted per test. These are behaviour tests: they assert on returned ClaimRecords
 * and on how many times claimReset was called, the observable effects.
 */
import { describe, test } from 'bun:test';

describe('claim safety', () => {
  test.todo('two concurrent confirm() on one claim → claimReset called exactly once; both get the same record');
  test.todo('confirm() after settle returns the settled record and does not call claimReset');
  test.todo('confirm() with a mismatched account or program echo → claim_mismatch, nothing sent');
  test.todo('confirm() after the prepare TTL → expired, nothing sent');
  test.todo('a second claim for the same account+program while one is in_doubt → claim_conflict');
  test.todo('process "crash": a row left in sending → recover() marks in_doubt and claimReset is not called');
  test.todo('claimReset times out → in_doubt; an unrecognized result string → in_doubt');
  test.todo('in_doubt juniper + at-wall poll with available=false → inferred_consumed + followup pending');
  test.todo('in_doubt cedar + grant resets_left unchanged → inferred_not_consumed, no followup');
  test.todo('result reset → CPA clearCooldown called once; if it fails, the sweep retries until done');
  test.todo('rate_limited / auth_error / not_sent → settled, followup not_needed, new prepare allowed');
  test.todo('cedar request_id sent to Anthropic equals the claim id');
});
