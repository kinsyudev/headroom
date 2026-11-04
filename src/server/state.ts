/**
 * var/state.json: the only thing the deck persists. Two facts that must survive a LaunchAgent
 * restart loop: a rejected management key (cpa.ts) and per-account Anthropic backoff
 * (anthropic.ts). Each key has one writer. Writes are synchronous temp-file-plus-rename, so a
 * crash leaves either the old file or the new one, and two writers can't interleave.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeckState {
  readonly keyRejected: { readonly keyHash: string; readonly at: number } | null;
  readonly backoff: Readonly<Record<string, number>>;
}

export interface StateFile {
  read(): DeckState;
  update(fn: (s: DeckState) => DeckState): void;
}

const EMPTY: DeckState = { keyRejected: null, backoff: {} };

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
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeckState>;
    const k = raw.keyRejected;
    return {
      keyRejected: k && typeof k.keyHash === 'string' && typeof k.at === 'number' ? { keyHash: k.keyHash, at: k.at } : null,
      backoff: Object.fromEntries(Object.entries(raw.backoff ?? {}).filter(([, v]) => typeof v === 'number')),
    };
  } catch {
    return EMPTY;
  }
}
