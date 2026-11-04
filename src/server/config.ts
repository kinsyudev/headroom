/**
 * Startup configuration and the management key.
 *
 * The key is read from keeper's env file. It is never hardcoded, never sent to the client, and
 * never logged. `ManagementKey` is a class, not a string, so `JSON.stringify`, template literals,
 * and `console.log` print "[redacted]". Only cpa.ts calls `reveal()`, once per request, to build the
 * Authorization header.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** 127.0.0.1 only. Not configurable on purpose. */
  readonly hostname: '127.0.0.1';
  readonly port: number; // 1338; keeper owns 1337
  readonly cpaBaseUrl: string; // http://127.0.0.1:8317
  readonly envPath: string; // /opt/homebrew/etc/cpa-usage-keeper.env
  readonly keeperDbPath: string; // /opt/homebrew/var/cpa-usage-keeper/app.db
  readonly deckDbPath: string; // ~/Library/Application Support/cpa-deck/deck.db
  /** Sent as `User-Agent: claude-cli/<v> (external, cli)`. If offers say `cli_version`, bump it. */
  readonly claudeCliVersion: string;
  /** The Mac's IANA zone, used to fold keeper's UTC hours into local days. */
  readonly timeZone: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // TODO: defaults below; allow env overrides for port and paths only (CPA_DECK_PORT, CPA_DECK_ENV_FILE, ...).
  // timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  void homedir;
  void join;
  throw new Error('not implemented');
}

export class ManagementKey {
  readonly #value: string;
  private constructor(value: string) {
    this.#value = value;
  }
  /** Returns null for a missing or blank value. A ManagementKey therefore always holds a non-empty string. */
  static from(value: string | undefined | null): ManagementKey | null {
    const v = value?.trim();
    return v ? new ManagementKey(v) : null;
  }
  reveal(): string {
    return this.#value;
  }
  equals(other: ManagementKey | null): boolean {
    return other !== null && other.#value === this.#value;
  }
  toJSON(): string {
    return '[redacted]';
  }
  toString(): string {
    return '[redacted]';
  }
}

/** Parse `CPA_MANAGEMENT_KEY=` from the env file. Handles optional quotes. null if the file or line is missing. */
export function readManagementKey(envPath: string): ManagementKey | null {
  throw new Error('not implemented');
}

/**
 * Call `onChange` when the env file's key changes. It doesn't fire on touches without a key change.
 * This is how a rejected link un-latches: the operator fixes the file, and we try once more.
 */
export function watchManagementKey(envPath: string, onChange: (key: ManagementKey | null) => void): () => void {
  // TODO: fs.watch(dirname(envPath)) (editors replace files); debounce 500 ms; re-read; compare with equals().
  throw new Error('not implemented');
}
