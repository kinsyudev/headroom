/**
 * Reset claims: the only code path that can consume a Claude reset.
 *
 * Anthropic's program status is the ledger, so there is no local journal. Per (account, program):
 *   1. A claim already in flight returns the same promise (double-click, second tab).
 *   2. One fresh `wall` read, subject to backoff. If it can't be made: not_claimable, stale.
 *   3. The pure offer derivation runs on that fresh sample. Not claimable: not_claimable, why.
 *   4. One POST reset_rate_limits. Never retried.
 *   5. On `reset` or `not_limited`, CPA reset-quota, at most 3 tries 2 s apart.
 *   6. Record settled or unknown, then ask for a wall read as soon as the budget allows.
 * A claim that landed before a crash shows up in the next read as unavailable or fewer resets
 * left, so step 3 refuses a repeat. One that never landed stays claimable, which is correct.
 */
import { DeckError } from '../shared/actions';
import { cedarState, explainOffer, juniperState, usableGrant } from '../shared/derive';
import type { AccountId, ClaimId, ClaimRecord, ClaimState, GrantId, ProgramId, SourceError } from '../shared/domain';
import type { Anthropic, Clock } from './anthropic';
import type { Cpa } from './cpa';
import type { Poller } from './poller';

export const FOLLOWUP_TRIES = 3;
export const FOLLOWUP_GAP_MS = 2_000;
export const KEEP_RESULTS = 20;

export interface Claims {
  claim(input: { readonly account: AccountId; readonly program: ProgramId; readonly grant?: GrantId | undefined }): Promise<ClaimRecord>;
  /** Newest first: in-flight claims and the last KEEP_RESULTS results. */
  list(): readonly ClaimRecord[];
}

export function createClaims(deps: {
  readonly anthropic: Anthropic;
  readonly cpa: Cpa;
  readonly poller: Poller;
  readonly clock: Clock;
  readonly followupGapMs?: number;
}): Claims {
  const flights = new Map<string, Promise<ClaimRecord>>();
  let records: ClaimRecord[] = [];

  function put(r: ClaimRecord): void {
    records = [r, ...records.filter((x) => x.id !== r.id)].slice(0, KEEP_RESULTS);
  }

  async function clearCooldown(account: AccountId): Promise<'done' | 'failed'> {
    for (let i = 0; i < FOLLOWUP_TRIES; i++) {
      if (i > 0) await deps.clock.sleep(deps.followupGapMs ?? FOLLOWUP_GAP_MS);
      try {
        await deps.cpa.clearCooldown(account);
        return 'done';
      } catch {
        // the next iteration retries; after the last one the claim reports followup 'failed'
      }
    }
    return 'failed';
  }

  async function run(account: AccountId, program: ProgramId, wanted: GrantId | undefined): Promise<ClaimRecord> {
    const fresh = await deps.poller.readWall(account);
    if (!fresh.ok) throw new DeckError('not_claimable', `stale: could not read fresh reset data (${describe(fresh.error)})`);
    if (fresh.value.mode !== 'wall') throw new DeckError('not_claimable', 'stale: the fresh read was not a wall read');

    const now = deps.clock.now();
    const cedar = fresh.value.cedar;
    const state = program === 'juniper_tide' ? juniperState(fresh.value.juniper) : cedarState(cedar, now);
    if (state.kind !== 'claimable') throw new DeckError('not_claimable', explainOffer(state));

    let grant: GrantId | null = null;
    if (program === 'cedar_ember') {
      grant = wanted ?? state.grant;
      const g = cedar?.grants.find((x) => x.id === grant);
      if (!cedar || !g || !usableGrant(cedar, g)) throw new DeckError('not_claimable', `grant ${grant} is not usable in the fresh read`);
    }
    const profile = deps.poller.profile(account);
    if (!profile) throw new DeckError('not_claimable', 'organization unknown: the profile has not been read yet');

    const record: ClaimRecord = { id: crypto.randomUUID() as ClaimId, account, program, grant, startedAt: now, state: { kind: 'sending' } };
    put(record);
    const attempt = await deps.anthropic.claim(
      account,
      program === 'juniper_tide'
        ? { program, orgUuid: profile.orgUuid }
        : { program, orgUuid: profile.orgUuid, grantId: grant!, requestId: record.id },
    );

    let final: ClaimState;
    if (attempt.kind === 'answered') {
      const consumedOrClear = attempt.outcome.result === 'reset' || attempt.outcome.result === 'not_limited';
      const followup = consumedOrClear ? await clearCooldown(account) : 'not_needed';
      final = { kind: 'settled', at: deps.clock.now(), outcome: attempt.outcome, followup };
    } else if (attempt.kind === 'not_sent') {
      final = { kind: 'settled', at: deps.clock.now(), outcome: { result: 'not_sent', why: attempt.why }, followup: 'not_needed' };
    } else {
      final = { kind: 'unknown', at: deps.clock.now(), why: attempt.why };
    }
    const done = { ...record, state: final };
    put(done);
    deps.poller.readSoon(account);
    return done;
  }

  return {
    claim({ account, program, grant }) {
      const key = `${account}:${program}`;
      const inFlight = flights.get(key);
      if (inFlight) return inFlight;
      const p = run(account, program, grant).finally(() => flights.delete(key));
      flights.set(key, p);
      return p;
    },
    list: () => records,
  };
}

function describe(e: SourceError): string {
  switch (e.kind) {
    case 'rate_limited':
      return `rate-limited until ${new Date(e.retryAt).toISOString()}`;
    case 'upstream':
      return `upstream ${e.status} ${e.message}`.trim();
    case 'malformed':
    case 'unavailable':
      return `${e.kind}: ${e.message}`;
    case 'auth':
      return `Anthropic auth ${e.status}`;
    default:
      return e.kind;
  }
}
