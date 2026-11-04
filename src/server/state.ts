/**
 * var/state.json: the only thing the deck persists. It holds what a LaunchAgent restart loop needs
 * to spend no more than one long-lived process would: the management keys CPA rejected (cpa.ts)
 * and each account's Anthropic read budget (anthropic.ts). Each part has one writer.
 * Writes are synchronous temp-file-plus-rename, so a crash leaves either the old file or the new
 * one, and two writers can't interleave.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface RejectedKey {
  /** sha256 of the key, so the file never holds the key itself. */
  readonly keyHash: string;
  readonly at: number;
}

export interface ReadBudget {
  /** When each usage read left, oldest first, kept for the last READ_CAP_WINDOW_MS. */
  readonly reads: readonly number[];
  /** Set by a 429. `streak` counts 429s since the last successful usage read and picks the ladder step. */
  readonly backoff: { readonly until: number; readonly streak: number } | null;
}

export interface DeckState {
  readonly rejectedKeys: readonly RejectedKey[];
  /** Keyed by account id. */
  readonly budgets: Readonly<Record<string, ReadBudget>>;
}

export interface StateFile {
  read(): DeckState;
  update(fn: (s: DeckState) => DeckState): void;
}

const EMPTY: DeckState = { rejectedKeys: [], budgets: {} };

const WireState = z.object({
  rejectedKeys: z.array(z.object({ keyHash: z.string(), at: z.number() })).catch([]),
  budgets: z
    .record(
      z.string(),
      z.object({
        reads: z.array(z.number()).catch([]),
        backoff: z.object({ until: z.number(), streak: z.number() }).nullable().catch(null),
      }),
    )
    .catch({}),
});

export function openStateFile(path: string): StateFile {
  let current = load(path);
  return {
    read: () => current,
    update(fn) {
      current = fn(current);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(current, null, 2));
      renameSync(tmp, path);
    },
  };
}

function load(path: string): DeckState {
  try {
    return WireState.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return EMPTY;
  }
}
