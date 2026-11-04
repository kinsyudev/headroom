import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { deriveDeck } from '../src/shared/derive';
import type { Instant, Snapshot } from '../src/shared/domain';

const ROOT = join(import.meta.dir, '..');
const URL = 'http://127.0.0.1:1338';
const WAIT_MS = 100_000;

mkdirSync(join(ROOT, 'var/screenshots'), { recursive: true });
const app = Bun.spawn(['bun', 'run', join(ROOT, 'src/main.ts')], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
const snapshot = async () => (await (await fetch(`${URL}/api/snapshot`)).json()) as Snapshot;

try {
  const start = Date.now();
  for (;;) {
    const s = await snapshot().catch(() => null);
    const feeds = s ? Object.values(s.feeds) : [];
    const settled = feeds.length > 0 && feeds.every((f) => f.limits.attemptedAt !== null);
    const linkDown = s !== null && s.link.kind !== 'ok';
    if (settled || linkDown || Date.now() - start > WAIT_MS) break;
    await Bun.sleep(2_000);
  }
  const s = await snapshot();
  const d = deriveDeck(s, Date.now() as Instant);
  const summary = {
    link: s.link.kind,
    strategy: d.strategy,
    cpaAccounts: s.cpa.last?.value.length ?? 0,
    servingEvidence: d.overview.servingEvidence,
    keeper: s.serving.error ? s.serving.error.value : `${s.serving.last?.value.length ?? 0} accounts seen`,
    serving: d.overview.serving.map((x) => `${x.email} (${x.why}, ${Math.round((Date.now() - x.lastAt) / 1000)}s ago)`),
    target: d.overview.target?.email ?? null,
    claimable: d.overview.claimable.map((c) => `${c.email} ${c.program}`),
    accounts: d.accounts.map((a) => ({
      email: a.email,
      plan: a.plan?.label ?? null,
      priority: a.routing.priority,
      role: a.routing.role.kind,
      atWall: a.atWall,
      limits: a.limits.map((l) => `${l.label} ${l.phase === 'open' ? `${l.percent}%` : l.phase} (${l.source.kind})`),
      offers: a.offers.map((o) => `${o.program}: ${o.state.kind}`),
      anthropic: (['limits', 'cedar', 'juniper', 'profile'] as const).map((k) => {
        const f = s.feeds[a.id]?.[k];
        return `${k}: ${f?.last ? 'ok' : f?.error ? `${f.error.value.kind}${f.error.value.kind === 'rate_limited' ? ` until ${new Date(f.error.value.retryAt).toLocaleTimeString()}` : ''}` : 'not yet'}`;
      }),
    })),
  };
  console.log(JSON.stringify(summary, null, 2));

  const foreign = await fetch(`${URL}/api/snapshot`, { headers: { Host: 'evil.example:1338' } });
  const bare = await fetch(`${URL}/api/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"no.such.action"}' });
  console.log(`guard: foreign Host -> ${foreign.status}, POST without X-CPA-Deck -> ${bare.status}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  await page.goto(URL);
  await page.waitForSelector('[data-testid="overview"]');
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: join(ROOT, 'var/screenshots/live.png'), fullPage: true });
  await browser.close();
  console.log('screenshot: var/screenshots/live.png');
} finally {
  app.kill('SIGTERM');
  await app.exited;
  console.log((await new Response(app.stdout).text()).trim());
  const err = (await new Response(app.stderr).text()).trim();
  if (err) console.log(err);
}
