/**
 * Reset claims. This is the only code path that can consume a Claude reset, and the only writer of
 * the `claims` table.
 *
 * State machine (the row in deck.db is the truth; memory is a cache of it):
 *
 *   prepare ─▶ prepared ──confirm (CAS)──▶ sending ──answered──▶ settled(outcome, followup)
 *                 │                           │                        │
 *              ttl 120 s                 timeout / crash /          followup: pending ─▶ done | failed
 *                 ▼                      unrecognized reply          (CPA reset-quota; idempotent;
 *              expired                        ▼                       retried at startup and every 60 s)
 *                                         in_doubt ──next at-wall poll──▶ settled(inferred_*)
 *
 * Invariants:
 * - Nothing is sent unless this process won the prepared→sending CAS, and that write is durable
 *   (synchronous=FULL) before the network call starts.
 * - At most one claim per (account, program) is in sending or in_doubt. A UNIQUE partial index in
 *   store.ts enforces this, so a second tab or a second process can't race past it.
 * - A claim is never resent automatically. in_doubt is resolved only by observation: compare the
 *   Preflight facts with a newer at-wall poll. juniper_tide has no idempotency key, so a blind resend
 *   could consume a second reset. cedar_ember's request_id is the claim id, which would make a resend
 *   safe if Anthropic dedupes on it, but the deck doesn't rely on that (see rationale, open questions).
 * - confirm() is idempotent on the claim id. A double-click, a client retry, or a second tab gets the
 *   current record back, not a second send.
 * - Only a reply of `reset` consumed a reset. rate_limited, auth_error, and not_sent are terminal and safe to re-prepare.
 */
import type { AccountId, ClaimId, ClaimRecord, GrantId, Instant, ProgramId, ResetPrograms, Sample } from '../shared/domain';
import type { Anthropic } from './anthropic';
import type { Cpa } from './cpa';
import type { Observer } from './observer';

export const PREPARE_TTL_MS = 120_000;
/** Refresh at-wall data during prepare if it's older than this (subject to rate budget). */
export const PREFLIGHT_MAX_AGE_MS = 90_000;
export const FOLLOWUP_RETRY_MS = 60_000;

export interface Claims {
  /**
   * TODO:
   * reject if openClaim(...) exists → DeckError('claim_conflict')
   * programs = await observer.ensureFresh(account, 'programs', PREFLIGHT_MAX_AGE_MS)
   * offer = deriveOffers(programs, table.open(account), now).find(o => o.program === program)
   * offer?.state.kind !== 'claimable' → DeckError('not_claimable', explainOffer(offer))
   * cedar: grant = input.grant ?? offer.defaultGrant; must be in offer.grants with usable=true
   * profile = await observer.profile(account)   → orgUuid (resolved now, so confirm can't fail on it after the CAS)
   * preflight = { programsAt, available: true, resetsLeft (cedar grant), nextAvailableAt, clears }
   * insert { id: crypto.randomUUID(), state: prepared(expiresAt: now + PREPARE_TTL_MS) }
   * Also expire any older prepared rows for the same account+program (supersede).
   */
  prepare(input: { account: AccountId; program: ProgramId; grant?: GrantId }): Promise<ClaimRecord>;

  /**
   * TODO:
   * row = table.get(claim) ?? DeckError('invalid')
   * row.account !== account || row.program !== program → DeckError('claim_mismatch')
   * row.state.kind !== 'prepared' → return row                       // idempotent replay
   * row.state.expiresAt <= now → transition(prepared → expired); return it
   * try won = transition(prepared → sending{sentAt: now})
   *   catch UNIQUE violation → DeckError('claim_conflict')
   * !won → return table.get(claim)                                     // lost the race to a concurrent confirm
   * observer.setUrgent(account, true); emit change
   * attempt = await anthropic.claimReset(account, toRequest(row))      // the irreversible call
   * switch attempt.kind:
   *   'answered':
   *     result 'unrecognized' → transition(sending → in_doubt)
   *     else → transition(sending → settled{outcome, followup: result in (reset, not_limited) ? 'pending' : 'not_needed'})
   *   'not_sent' → transition(sending → settled{ {result: not_sent, why}, followup: 'not_needed' })
   *   'unknown'  → transition(sending → in_doubt{sentAt})
   * if followup pending → await runFollowup(row)
   * observer.setUrgent(account, hasOpen(account)); observer.kick(account); emit change
   * return table.get(claim)
   */
  confirm(input: { claim: ClaimId; account: AccountId; program: ProgramId }): Promise<ClaimRecord>;

  /**
   * Startup. Run before the HTTP server accepts actions.
   * TODO:
   * every 'sending' row → in_doubt (we crashed with it on the wire); setUrgent(account)
   * every 'prepared' row past expiresAt → expired
   * every settled row with followup pending|failed → runFollowup
   * schedule a sweep every FOLLOWUP_RETRY_MS for followup pending|failed and prepared expiry
   */
  recover(): Promise<void>;

  /**
   * Called by observer.onPrograms after each successful at-wall poll.
   * TODO: for each in_doubt row on `account` where programs.at > row.state.sentAt:
   *   juniper: p.juniperTide?.available === false && preflight.available → inferred_consumed
   *            p.juniperTide?.available === true                          → inferred_not_consumed
   *   cedar:   g = grant(row.grant) in p.cedarEmber.grants
   *            !g || g.resetsLeft < preflight.resetsLeft → inferred_consumed
   *            g.resetsLeft === preflight.resetsLeft     → inferred_not_consumed
   *   transition(in_doubt → settled{ outcome, followup: consumed ? 'pending' : 'not_needed' })
   *   (A consumed claim still needs CPA reset-quota, or CPA keeps cooling the account down.)
   */
  reconcile(account: AccountId, programs: Sample<ResetPrograms>): void;

  /** Open claims plus the 20 most recent closed ones, newest first. This is the Snapshot part. */
  list(): readonly ClaimRecord[];
  onChange(cb: () => void): () => void;
}

export function createClaims(deps: {
  readonly anthropic: Anthropic;
  readonly cpa: Cpa;
  readonly observer: Observer;
  readonly now: () => Instant;
}): Claims {
  throw new Error('not implemented');
}

/**
 * CPA reset-quota after a reset (or not_limited), so CPA stops cooling the account down.
 * Idempotent: clearing an already-clear cooldown is a no-op in CPA.
 * TODO: try cpa.clearCooldown(account) → followup 'done'; catch → 'failed' (the sweep retries);
 *       then observer.refreshCpa()
 */
async function runFollowup(row: ClaimRecord, deps: { cpa: Cpa; observer: Observer; now: () => Instant }): Promise<void> {
  throw new Error('not implemented');
}
