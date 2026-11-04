import { DeckError } from '../shared/errors';
import { cedarState, explainOffer, holdingClaim, juniperState, programReadAt, SETTLE_LAG_MS, usableGrant } from '../shared/derive';
import type { AccountId, ClaimId, ClaimRecord, ClaimState, GrantId, Instant, ProgramId, SourceError } from '../shared/domain';
import { READ_CAP, type Anthropic, type Clock } from './anthropic';
import type { Cpa } from './cpa';
import type { Poller } from './poller';
import type { StateFile } from './state';

export const FOLLOWUP_TRIES = 3;
export const FOLLOWUP_GAP_MS = 2_000;
export const KEEP_RESULTS = 20;

export interface Claims {
  claim(input: { readonly account: AccountId; readonly program: ProgramId; readonly grant?: GrantId | undefined }): Promise<ClaimRecord>;
  list(): readonly ClaimRecord[];
}

export function createClaims(deps: {
  readonly anthropic: Anthropic;
  readonly cpa: Cpa;
  readonly poller: Poller;
  readonly clock: Clock;
  readonly followupGapMs?: number;
  readonly state?: StateFile;
}): Claims {
  const flights = new Map<string, Promise<ClaimRecord>>();
  let records = restore(deps.state, deps.clock.now());
  for (const r of records) if (r.state.kind !== 'sending') deps.poller.wantWall(r.account, (r.state.at + SETTLE_LAG_MS) as Instant);

  function put(r: ClaimRecord): void {
    records = [r, ...records.filter((x) => x.id !== r.id)].slice(0, KEEP_RESULTS);
    deps.state?.update((s) => ({ ...s, claims: records }));
  }

  async function clearCooldown(account: AccountId): Promise<'done' | 'failed'> {
    for (let i = 0; i < FOLLOWUP_TRIES; i++) {
      if (i > 0) await deps.clock.sleep(deps.followupGapMs ?? FOLLOWUP_GAP_MS);
      try {
        await deps.cpa.clearCooldown(account);
        return 'done';
      } catch {
      }
    }
    return 'failed';
  }

  function refuseWhileHeld(account: AccountId, program: ProgramId, readAt: Instant | null): void {
    const holding = holdingClaim(records, account, program, readAt);
    if (!holding) return;
    throw new DeckError(
      'not_claimable',
      holding.state.kind === 'sending'
        ? 'a claim for this program is already in flight'
        : `held: the last claim's outcome shows only in a read taken at or after ${new Date(holding.state.at + SETTLE_LAG_MS).toISOString()}`,
    );
  }

  async function run(account: AccountId, program: ProgramId, wanted: GrantId | undefined): Promise<ClaimRecord> {
    const feeds = deps.poller.feeds()[account];
    refuseWhileHeld(account, program, feeds ? programReadAt(feeds, program) : null);
    const fresh = await deps.poller.readWall(account);
    if (!fresh.ok) throw new DeckError('not_claimable', `stale: could not read fresh reset data (${describe(fresh.error)})`);
    if (fresh.value.mode !== 'wall') throw new DeckError('not_claimable', 'stale: the fresh read was not a wall read');
    refuseWhileHeld(account, program, fresh.at);

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
      final = { kind: 'maybe_sent', at: deps.clock.now(), why: attempt.why };
    }
    const done = { ...record, state: final };
    put(done);
    deps.poller.wantWall(account, (final.at + SETTLE_LAG_MS) as Instant);
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

function restore(state: StateFile | undefined, now: Instant): ClaimRecord[] {
  return ((state?.read().claims ?? []) as ClaimRecord[]).map((r) =>
    r.state.kind === 'sending' ? { ...r, state: { kind: 'maybe_sent', at: now, why: 'Headroom restarted while this claim was being sent' } } : r,
  );
}

function describe(e: SourceError): string {
  switch (e.kind) {
    case 'rate_limited':
      return `rate-limited until ${new Date(e.retryAt).toISOString()}`;
    case 'read_cap':
      return `read cap: ${READ_CAP} reads in 15 min used, next read allowed at ${new Date(e.retryAt).toISOString()}`;
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
