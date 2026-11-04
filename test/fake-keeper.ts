import { Database } from 'bun:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = readFileSync(join(import.meta.dir, 'fixtures/keeper-schema.sql'), 'utf8');
const ids = [1, 2, 3].map((n) => readFileSync(join(import.meta.dir, `fixtures/auth-index-${n}.txt`), 'utf8').trim());
export const [KEEPER_ACC2, KEEPER_ACC1, KEEPER_ACC3] = ids as [string, string, string];

/** keeper writes local time in its own zone: 2026-11-04T20:04:26.660000+08:00. */
export function keeperTime(ms: number): string {
  return `${new Date(ms + 8 * 3_600_000).toISOString().slice(0, 23)}000+08:00`;
}

interface Row {
  readonly at: number;
  readonly account: string;
  readonly model: string;
  readonly failed?: boolean;
  readonly status?: number;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
}

export function insertUsage(db: Database, r: Row): void {
  db.query(
    `INSERT INTO usage_events (timestamp, auth_index, model, provider, failed, status_code, latency_ms, ttft_ms,
       input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens)
     VALUES (?, ?, ?, 'claude', ?, ?, 1200, 400, ?, ?, 0, ?, ?, ?)`,
  ).run(
    keeperTime(r.at),
    r.account,
    r.model,
    r.failed ? 1 : 0,
    r.status ?? 200,
    r.input ?? 0,
    r.output ?? 0,
    r.cacheRead ?? 0,
    r.cacheCreation ?? 0,
    (r.input ?? 0) + (r.output ?? 0),
  );
}

export function createKeeperDb(path: string, now = Date.now()): void {
  rmSync(path, { force: true });
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  db.transaction(() => {
    for (let h = 30 * 24; h >= 1; h--) {
      const hourStart = Math.floor((now - h * 3_600_000) / 3_600_000) * 3_600_000;
      const busy = new Date(hourStart).getUTCHours() % 24 < 14;
      for (const [i, account] of ids.entries()) {
        const n = busy ? Math.floor(rand() * (i === 1 ? 9 : 4)) : 0;
        for (let k = 0; k < n; k++) {
          const input = 20_000 + Math.floor(rand() * 60_000);
          const cacheRead = Math.floor(input * 0.7);
          insertUsage(db, {
            at: hourStart + Math.floor(rand() * 3_600_000),
            account,
            model: models[Math.floor(rand() * models.length)]!,
            input,
            cacheRead,
            cacheCreation: Math.floor(input * 0.1),
            output: 500 + Math.floor(rand() * 3_000),
            failed: rand() < 0.02,
            status: rand() < 0.02 ? 429 : 200,
          });
        }
      }
    }
    insertUsage(db, { at: now - 10 * 60_000, account: KEEPER_ACC2, model: 'claude-opus-5-5', input: 1000, output: 100 });
    insertUsage(db, { at: now - 90_000, account: KEEPER_ACC3, model: 'claude-opus-5-5', failed: true, status: 429 });
    insertUsage(db, { at: now - 20_000, account: KEEPER_ACC1, model: 'claude-opus-5-5', input: 50_000, cacheRead: 40_000, cacheCreation: 5_000, output: 900 });
    insertUsage(db, { at: now - 5_000, account: KEEPER_ACC1, model: 'claude-sonnet-5-5', input: 30_000, cacheRead: 20_000, cacheCreation: 0, output: 400 });
    const err = db.query(
      `INSERT INTO error_events (timestamp, auth_index, model, status_code, body, auth_quota_reason, auth_quota_next_recover_at)
       VALUES (?, ?, 'claude-opus-5-5', 429, ?, ?, ?)`,
    );
    const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's monthly spend limit." } });
    err.run(keeperTime(now - 3_600_000), KEEPER_ACC3, body, 'credential_quota', keeperTime(now + 2 * 3_600_000));
    err.run(keeperTime(now - 1_800_000), 'ffffffffffffffff', body, 'quota', null);
  })();
  db.close();
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: bun test/fake-keeper.ts <path>');
  createKeeperDb(path);
  const db = new Database(path);
  setInterval(() => insertUsage(db, { at: Date.now(), account: KEEPER_ACC1, model: 'claude-opus-5-5', input: 12_000, cacheRead: 9_000, output: 300 }), 5_000);
  console.log(`fake keeper db at ${path}`);
}
