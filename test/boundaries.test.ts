import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { inspect } from 'node:util';
import { loadConfig, readManagementKey, Secret } from '../src/server/config';
import { parseRefresh } from '../src/server/cpa';
import { SQL } from '../src/server/keeper';

const SRC = join(import.meta.dir, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const sources = files(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const where = (re: RegExp) => sources.filter((s) => re.test(code(s.text))).map((s) => s.path).sort();
const imports = (text: string) => [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

describe('hard constraints', () => {
  test('nothing consumes CPA usage: no usage-queue, LPOP or SUBSCRIBE anywhere', () => {
    expect(where(/usage-queue|LPOP|SUBSCRIBE/i)).toEqual([]);
  });

  test('no DELETE request exists, and auth files are never deleted', () => {
    expect(where(/['"]DELETE['"]/)).toEqual([]);
  });

  test('keeper is opened mode=ro and readonly, and every query is a SELECT', () => {
    const keeper = sources.find((s) => s.path === 'server/keeper.ts')!.text;
    expect(keeper).toContain('?mode=ro`, { readonly: true }');
    expect(keeper).toContain("PRAGMA query_only = ON");
    for (const sql of Object.values(SQL)) expect(sql.trim()).toMatch(/^SELECT\b/);
    expect(where(/new Database\(/)).toEqual(['server/keeper.ts']);
  });

  test('fetch( only in cpa.ts (holds the key) and ui/api.ts (same-origin)', () => {
    expect(where(/\bfetch\(/)).toEqual(['server/cpa.ts', 'ui/api.ts']);
  });

  test('the management key is revealed only inside cpa.ts', () => {
    expect(where(/\.reveal\(\)/)).toEqual(['server/cpa.ts']);
  });

  test('Anthropic requests leave only through anthropic.ts, and claims through claims.ts', () => {
    expect(where(/\.apiCall\(/)).toEqual(['server/anthropic.ts']);
    expect(where(/anthropic\.claim\(/)).toEqual(['server/claims.ts']);
  });

  test('the server binds 127.0.0.1 only, whatever the environment says', () => {
    expect(loadConfig({ CPA_DECK_PORT: '1338', CPA_DECK_CLI_VERSION: '1.0.0' }).hostname).toBe('127.0.0.1');
    expect(where(/0\.0\.0\.0/)).toEqual([]);
  });

  test('only keeper.ts names input_tokens', () => {
    expect(where(/input_tokens/)).toEqual(['server/keeper.ts']);
  });

  test('no package script hot-reloads the deck, which would leave the old pollers running', () => {
    const scripts = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf8')).scripts as Record<string, string>;
    expect(Object.entries(scripts).filter(([, cmd]) => /--(hot|watch)\b/.test(cmd))).toEqual([]);
  });
});

describe('layering', () => {
  test('src/ui never imports src/server', () => {
    const bad = sources.filter((s) => s.path.startsWith('ui/') && imports(s.text).some((i) => i.includes('/server/')));
    expect(bad.map((s) => s.path)).toEqual([]);
  });

  test('src/shared imports only shared modules and zod, because it runs in the browser', () => {
    const bad = sources.filter((s) => s.path.startsWith('shared/') && imports(s.text).some((i) => i !== 'zod' && !i.startsWith('./')));
    expect(bad.map((s) => s.path)).toEqual([]);
  });

  test('components render from view types: no Snapshot and no derive imports below App', () => {
    const bad = sources.filter((s) => s.path.startsWith('ui/components/') && (/\bSnapshot\b/.test(code(s.text)) || imports(s.text).some((i) => i.endsWith('shared/derive'))));
    expect(bad.map((s) => s.path)).toEqual([]);
  });

  test('wire schemas stay private to the module that parses them', () => {
    expect(where(/export\s+(const|function|type|interface)\s+Wire/)).toEqual([]);
  });
});

describe('secrets', () => {
  test('parseRefresh keeps only ok', () => {
    const parsed = parseRefresh({ ok: true, auth: { access_token: 'sk-ant-oat01-x', refresh_token: 'sk-ant-ort01-y' } });
    expect(parsed).toEqual({ ok: true });
    expect(JSON.stringify(parsed)).not.toContain('sk-ant');
  });

  test('a Secret redacts itself in JSON, strings, templates and inspect', () => {
    const k = Secret.from('super-secret-key')!;
    expect(JSON.stringify({ k })).toBe('{"k":"[redacted]"}');
    expect(String(k)).toBe('[redacted]');
    expect(`${k}`).toBe('[redacted]');
    expect(inspect(k)).not.toContain('super-secret-key');
    expect(Bun.inspect({ k })).not.toContain('super-secret-key');
  });

  test('readManagementKey handles quotes and a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-env-'));
    writeFileSync(join(dir, 'env'), 'APP_PORT=1337\nCPA_MANAGEMENT_KEY="quoted-key"\n');
    expect(readManagementKey(join(dir, 'env'))?.reveal()).toBe('quoted-key');
    expect(readManagementKey('/nonexistent/env')).toBeNull();
    rmSync(dir, { recursive: true });
  });
});
