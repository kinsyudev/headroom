/**
 * Polling bounds, tested on the pure nextAttemptAt() plus a fake-clock run of the observer loop.
 * The rate-limit fixtures (anthropic-usage-*.json, all rate_limit_error bodies) drive the 429 path.
 */
import { describe, test } from 'bun:test';

describe('polling bounds', () => {
  test.todo('no (account, endpoint) slot is attempted twice within 60 s, including manual and boundary triggers');
  test.todo('no two Anthropic calls start within 5 s of each other across all accounts');
  test.todo('startup with 3 accounts and an empty deck.db staggers first calls 5 s apart');
  test.todo('a body {error:{type:"rate_limit_error"}} with status_code 200 is treated as rate-limited');
  test.todo('a rate limit backs off every endpoint of that account: 2, 4, 8, ... capped at 30 min, and never sooner than retry-after');
  test.todo('restart with persisted backoff → first call waits for limited_until');
  test.todo('quota.refresh within 20 s of the last attempt reports held=debounced; during backoff, held=rate_limited');
  test.todo('profile is re-fetched only after 6 h');
  test.todo('link down → zero calls of any kind, all Sources show error link_down');
});

describe('feed grouping', () => {
  test.todo('an at-wall success newer than the last usage success replaces `limits`');
  test.todo('an older usage success arriving later does not overwrite newer `limits`');
});

describe('lockout', () => {
  test.todo('one 401 latches rejected; no further request is sent until setKey with a different key');
  test.todo('two persisted failures within 30 min → validate() sends nothing and reports guarded');
});
