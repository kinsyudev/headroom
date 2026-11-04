/**
 * Startup configuration and the management key. The key lives in keeper's env file and is held in
 * a `Secret`, which prints "[redacted]" through JSON.stringify, template literals and inspect.
 * Only cpa.ts calls `reveal()`, once per request, to build the Authorization header.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  /** Not configurable on purpose. */
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly cpaBaseUrl: string;
  readonly envPath: string;
  readonly keeperDbPath: string;
  /** Holds state.json. */
  readonly stateDir: string;
  /** Sent as `User-Agent: claude-cli/<v> (external, cli)`. */
  readonly claudeCliVersion: string;
}

export const FALLBACK_CLI_VERSION = '2.1.311';

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    hostname: '127.0.0.1',
    port: Number(env.CPA_DECK_PORT ?? 1338),
    cpaBaseUrl: env.CPA_BASE_URL ?? 'http://127.0.0.1:8317',
    envPath: env.CPA_DECK_ENV_FILE ?? '/opt/homebrew/etc/cpa-usage-keeper.env',
    keeperDbPath: env.CPA_DECK_KEEPER_DB ?? '/opt/homebrew/var/cpa-usage-keeper/app.db',
    stateDir: env.CPA_DECK_STATE_DIR ?? join(import.meta.dir, '../../var'),
    claudeCliVersion: env.CPA_DECK_CLI_VERSION ?? detectCliVersion(),
  };
}

function detectCliVersion(): string {
  try {
    const r = Bun.spawnSync(['claude', '--version'], { timeout: 5_000, stdout: 'pipe', stderr: 'ignore' });
    return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? FALLBACK_CLI_VERSION;
  } catch {
    return FALLBACK_CLI_VERSION;
  }
}

export class Secret {
  readonly #value: string;
  private constructor(value: string) {
    this.#value = value;
  }
  /** null for a missing or blank value, so a Secret always holds a non-empty string. */
  static from(value: string | undefined | null): Secret | null {
    const v = value?.trim();
    return v ? new Secret(v) : null;
  }
  reveal(): string {
    return this.#value;
  }
  /** sha256 hex, so state.json can remember a rejected key without storing it. */
  hash(): string {
    return createHash('sha256').update(this.#value).digest('hex');
  }
  toJSON(): string {
    return '[redacted]';
  }
  toString(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([redacted])';
  }
}

/** `CPA_MANAGEMENT_KEY=` from the env file, with optional quotes. null if the file or line is missing. */
export function readManagementKey(envPath: string): Secret | null {
  let text: string;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  const line = /^\s*(?:export\s+)?CPA_MANAGEMENT_KEY\s*=\s*(.*)$/m.exec(text)?.[1]?.trim();
  return Secret.from(line?.replace(/^(['"])(.*)\1$/, '$2'));
}
