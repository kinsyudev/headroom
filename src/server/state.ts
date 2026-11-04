/**
 * var/state.json: the only thing the deck persists. Two facts that must survive a LaunchAgent
 * restart loop: the management keys CPA rejected (cpa.ts) and per-account Anthropic backoff
 * (anthropic.ts). Each key has one writer. Writes are synchronous temp-file-plus-rename, so a
 * crash leaves either the old file or the new one, and two writers can't interleave.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface RejectedKey {
  /** sha256 of the key, so the file never holds the key itself. */
  readonly keyHash: string;
  readonly at: number;
}

export interface DeckState {
  readonly rejectedKeys: readonly RejectedKey[];
  readonly backoff: Readonly<Record<string, number>>;
}

export interface StateFile {
  read(): DeckState;
  update(fn: (s: DeckState) => DeckState): void;
}

const EMPTY: DeckState = { rejectedKeys: [], backoff: {} };

const WireState = z.object({
  rejectedKeys: z.array(z.object({ keyHash: z.string(), at: z.number() })).catch([]),
  backoff: z.record(z.string(), z.number()).catch({}),
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
