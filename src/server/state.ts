import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface RejectedKey {
  readonly keyHash: string;
  readonly at: number;
}

export interface ReadBudget {
  readonly reads: readonly number[];
  readonly backoff: { readonly until: number; readonly streak: number } | null;
}

export interface DeckState {
  readonly rejectedKeys: readonly RejectedKey[];
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
