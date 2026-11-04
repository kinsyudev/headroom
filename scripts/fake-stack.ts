/**
 * The deck wired to the fake CPA and a generated keeper DB, so nothing real is touched.
 *
 *   bun scripts/fake-stack.ts        serve on http://127.0.0.1:1338 until Ctrl-C
 *
 * scripts/e2e.ts imports startStack() and drives the same stack with Playwright.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeCpa, type FakeCpa } from '../test/fake-cpa';
import { createKeeperDb, insertUsage, KEEPER_ACC1 } from '../test/fake-keeper';

const ROOT = join(import.meta.dir, '..');
const KEY = 'fake-stack-management-key';

export interface Stack {
  readonly url: string;
  readonly port: number;
  readonly fake: FakeCpa;
  stop(): Promise<void>;
}

export async function startStack(opts: { readonly port?: number; readonly log?: string } = {}): Promise<Stack> {
  const port = opts.port ?? 1338;
  const dir = mkdtempSync(join(tmpdir(), 'cpa-deck-stack-'));
  const fake = startFakeCpa({ key: KEY });
  writeFileSync(join(dir, 'cpa-usage-keeper.env'), `APP_PORT=1337\nCPA_MANAGEMENT_KEY=${KEY}\n`);
  const keeperPath = join(dir, 'app.db');
  createKeeperDb(keeperPath);
  const keeper = new Database(keeperPath);
  const traffic = setInterval(
    () => insertUsage(keeper, { at: Date.now(), account: KEEPER_ACC1, model: 'claude-opus-5-5', input: 12_000, cacheRead: 9_000, output: 300 }),
    5_000,
  );

  const logPath = opts.log ?? join(ROOT, 'var/fake-stack.log');
  mkdirSync(join(ROOT, 'var'), { recursive: true });
  const app = Bun.spawn(['bun', 'run', join(ROOT, 'src/main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CPA_BASE_URL: fake.url,
      CPA_DECK_PORT: String(port),
      CPA_DECK_ENV_FILE: join(dir, 'cpa-usage-keeper.env'),
      CPA_DECK_KEEPER_DB: keeperPath,
      CPA_DECK_STATE_DIR: join(dir, 'state'),
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    const ok = await fetch(`${url}/api/snapshot`).then((r) => r.ok, () => false);
    if (ok) break;
    if (i > 100 || app.exitCode !== null) throw new Error(`deck did not start; see ${logPath}`);
    await Bun.sleep(100);
  }

  return {
    url,
    port,
    fake,
    async stop() {
      clearInterval(traffic);
      app.kill('SIGTERM');
      await app.exited;
      keeper.close();
      fake.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const stack = await startStack();
  console.log(`deck on ${stack.url}, fake CPA on ${stack.fake.url}`);
  const stop = () => void stack.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
