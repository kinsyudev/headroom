import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Instant } from '../shared/domain';

export interface RejectedKey {
  readonly keyHash: string;
  readonly at: number;
}

export class ReadLog {
  static readonly empty = new ReadLog([]);

  constructor(private readonly times: readonly Instant[]) {}

  get last(): Instant | null {
    return this.times.at(-1) ?? null;
  }

  nthNewest(n: number): Instant | null {
    return this.times[this.times.length - n] ?? null;
  }

  since(start: number): ReadLog {
    return new ReadLog(this.times.filter((t) => t > start));
  }

  append(at: Instant): ReadLog {
    return new ReadLog([...this.times, at]);
  }

  without(at: Instant): ReadLog {
    return new ReadLog(this.times.filter((t) => t !== at));
  }

  toJSON(): readonly Instant[] {
    return this.times;
  }
}

export interface ReadBudget {
  readonly reads: ReadLog;
  readonly backoff: { readonly until: number; readonly streak: number } | null;
}

export type StoredFeed = 'limits' | 'spend' | 'cedar' | 'juniper' | 'profile';
export type StoredSamples = Partial<Record<StoredFeed, { readonly value: unknown; readonly at: number }>>;

/** Bump when a stored feed's or ClaimRecord's domain type changes, so an old file's copies are dropped instead of misread. */
export const STORED_VERSION = 1;

export interface DeckState {
  readonly rejectedKeys: readonly RejectedKey[];
  readonly budgets: Readonly<Record<string, ReadBudget>>;
  readonly storedVersion: number;
  readonly samples: Readonly<Record<string, StoredSamples>>;
  readonly claims: readonly unknown[];
}

export interface StateFile {
  read(): DeckState;
  update(fn: (s: DeckState) => DeckState): void;
}

const EMPTY: DeckState = { rejectedKeys: [], budgets: {}, storedVersion: STORED_VERSION, samples: {}, claims: [] };

const WireState = z.object({
  rejectedKeys: z.array(z.object({ keyHash: z.string(), at: z.number() })).catch([]),
  budgets: z
    .record(
      z.string(),
      z.object({
        reads: z
          .array(z.number())
          .catch([])
          .transform((times) => new ReadLog(times as Instant[])),
        backoff: z.object({ until: z.number(), streak: z.number() }).nullable().catch(null),
      }),
    )
    .catch({}),
  storedVersion: z.number().catch(0),
  samples: z.record(z.string(), z.record(z.string(), z.object({ value: z.unknown(), at: z.number() }))).catch({}),
  claims: z.array(z.unknown()).catch([]),
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
    const s = WireState.parse(JSON.parse(readFileSync(path, 'utf8')));
    return s.storedVersion === STORED_VERSION ? (s as DeckState) : { ...s, storedVersion: STORED_VERSION, samples: {}, claims: [] };
  } catch {
    return EMPTY;
  }
}
