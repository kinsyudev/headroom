/**
 * deck.db: the deck's own small SQLite file (bun:sqlite, WAL, synchronous=FULL).
 * This is the only database the deck writes. Keeper's DB is opened read-only in keeper.ts.
 *
 * It holds the three things that must survive a restart:
 * - claims: the reset-claim journal. A crash mid-claim has to be visible after restart.
 * - poll_slots: last value and backoff per (account, endpoint). Without it, a LaunchAgent restart
 *   loop would re-poll Anthropic from scratch every launch and run straight into 429s.
 * - auth_failures: the management-key lockout budget, so restarts can't add up to CPA's 5-strike ban.
 *
 * Each table has exactly one writing module: claims → claims.ts, poll_slots → observer.ts,
 * auth_failures → cpa.ts. Store hands each module only its own accessor (see `Store`).
 */
import { Database } from 'bun:sqlite';
import type { AccountId, ClaimId, ClaimRecord, ClaimState, Instant, ProgramId } from '../shared/domain';

export const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS claims (
  id          TEXT PRIMARY KEY,                -- uuid v4; also cedar_ember request_id
  account     TEXT NOT NULL,
  program     TEXT NOT NULL CHECK (program IN ('juniper_tide', 'cedar_ember')),
  grant_id    TEXT,
  org_uuid    TEXT NOT NULL,                   -- resolved at prepare so confirm needs no extra fetch
  created_at  INTEGER NOT NULL,
  preflight   TEXT NOT NULL,                   -- JSON Preflight
  state       TEXT NOT NULL CHECK (state IN ('prepared','expired','sending','in_doubt','settled')),
  state_json  TEXT NOT NULL,                   -- JSON ClaimState (the full union; 'state' column is for indexes)
  updated_at  INTEGER NOT NULL
);
-- At most one claim per account+program may be on the wire or unresolved. This is the structural
-- guard against double-claims; claims.ts relies on it and does not re-check in code.
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_open
  ON claims (account, program) WHERE state IN ('sending', 'in_doubt');

CREATE TABLE IF NOT EXISTS poll_slots (
  account      TEXT NOT NULL,
  endpoint     TEXT NOT NULL CHECK (endpoint IN ('usage', 'at_wall', 'profile')),
  value_json   TEXT,                           -- last parsed domain value (not the wire body)
  ok_at        INTEGER,
  error_json   TEXT,
  error_at     INTEGER,
  attempt_at   INTEGER,
  next_at      INTEGER NOT NULL,
  streak       INTEGER NOT NULL DEFAULT 0,     -- consecutive failures
  PRIMARY KEY (account, endpoint)
);
CREATE TABLE IF NOT EXISTS account_backoff (
  account          TEXT PRIMARY KEY,
  limited_until    INTEGER NOT NULL,           -- Anthropic 429 backoff, shared by all endpoints of the account
  limited_streak   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_failures (at INTEGER NOT NULL);
`;

export interface PollSlotRow {
  readonly account: AccountId;
  readonly endpoint: 'usage' | 'at_wall' | 'profile';
  readonly valueJson: string | null;
  readonly okAt: Instant | null;
  readonly errorJson: string | null;
  readonly errorAt: Instant | null;
  readonly attemptAt: Instant | null;
  readonly nextAt: Instant;
  readonly streak: number;
}

export interface ClaimsTable {
  insert(c: ClaimRecord & { orgUuid: string }): void;
  get(id: ClaimId): (ClaimRecord & { orgUuid: string }) | null;
  /**
   * Compare-and-set. Applies `to` only if the row's current state kind is `from`.
   * Returns false if another caller won the race or the state moved on.
   * Throws SQLITE_CONSTRAINT_UNIQUE when moving into sending/in_doubt while another claim for the
   * same account+program is open. claims.ts maps that to DeckError('claim_conflict').
   */
  transition(id: ClaimId, from: ClaimState['kind'], to: ClaimState, now: Instant): boolean;
  inState(kinds: readonly ClaimState['kind'][]): ClaimRecord[];
  open(account: AccountId, program?: ProgramId): ClaimRecord[];
  recent(limit: number): ClaimRecord[];
}

export interface PollSlotsTable {
  loadAll(): PollSlotRow[];
  save(row: PollSlotRow): void;
  loadBackoff(): { account: AccountId; limitedUntil: Instant; streak: number }[];
  saveBackoff(account: AccountId, limitedUntil: Instant, streak: number): void;
}

export interface AuthFailuresTable {
  record(at: Instant): void;
  countSince(since: Instant): number;
  oldestSince(since: Instant): Instant | null;
}

export interface Store {
  readonly claims: ClaimsTable;
  readonly pollSlots: PollSlotsTable;
  readonly authFailures: AuthFailuresTable;
  close(): void;
}

export function openStore(path: string): Store {
  // TODO: mkdir -p dirname; new Database(path, { create: true, strict: true }); db.exec(SCHEMA);
  // prepare statements once; transition() = UPDATE ... SET state=?, state_json=?, updated_at=?
  //   WHERE id=? AND state=?  → changes === 1
  void Database;
  throw new Error('not implemented');
}
