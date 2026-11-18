import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly cpaBaseUrl: string;
  /** cpaBaseUrl without any user or password it carries: the only form the page may print. */
  readonly cpaAddress: string;
  readonly envPath: string;
  readonly keeperDbPath: string;
  readonly stateDir: string;
  readonly claudeCliVersion: string;
}

declare const HEADROOM_PACKAGED: boolean | undefined;

export const FALLBACK_CLI_VERSION = '2.1.311';

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cpaBaseUrl = env.CPA_BASE_URL ?? 'http://127.0.0.1:8317';
  return {
    hostname: '127.0.0.1',
    port: Number(env.HEADROOM_PORT ?? 1338),
    cpaBaseUrl,
    cpaAddress: withoutCredentials(cpaBaseUrl),
    envPath: env.HEADROOM_ENV_FILE ?? '/opt/homebrew/etc/cpa-usage-keeper.env',
    keeperDbPath: env.HEADROOM_KEEPER_DB ?? '/opt/homebrew/var/cpa-usage-keeper/app.db',
    stateDir: env.HEADROOM_STATE_DIR ?? defaultStateDir(),
    claudeCliVersion: env.HEADROOM_CLI_VERSION ?? detectCliVersion(),
  };
}

/** A compiled binary's import.meta.dir is a read-only virtual path, so state goes where macOS apps keep it. */
function defaultStateDir(): string {
  const packaged = typeof HEADROOM_PACKAGED !== 'undefined' && HEADROOM_PACKAGED;
  return packaged ? join(homedir(), 'Library/Application Support/Headroom') : join(import.meta.dir, '../../var');
}

function withoutCredentials(url: string): string {
  const u = new URL(url);
  u.username = '';
  u.password = '';
  return u.href.replace(/\/$/, '');
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
  static from(value: string | undefined | null): Secret | null {
    const v = value?.trim();
    return v ? new Secret(v) : null;
  }
  reveal(): string {
    return this.#value;
  }
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
