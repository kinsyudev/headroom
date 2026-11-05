import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { deriveDeck } from '../src/shared/derive';
import type { Instant, Snapshot } from '../src/shared/domain';

// Checks the Headroom that is already running, with GETs and a page load only. Never start a second one here:
// two Headrooms double the Anthropic usage reads, and that rate-limits every account for about 35 minutes.

const ROOT = join(import.meta.dir, '..');
const PORT = process.env.HEADROOM_PORT ?? '1338';
const URL = `http://127.0.0.1:${PORT}`;
const SHOT = 'var/screenshots/live.png';

const answer = await fetch(`${URL}/api/snapshot`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
if (!answer?.ok) {
  console.error(answer ? `${URL}/api/snapshot answered ${answer.status}` : `nothing answers at ${URL}. Start the live Headroom first; this script never starts one.`);
  process.exit(1);
}

const s = (await answer.json()) as Snapshot;
const d = deriveDeck(s, Date.now() as Instant);
const summary = {
  link: s.link.kind,
  strategy: d.strategy,
  cpaAccounts: s.cpa.last?.value.length ?? 0,
  servingEvidence: d.overview.servingEvidence,
  keeper: s.serving.error ? s.serving.error.value : `${s.serving.last?.value.length ?? 0} accounts seen`,
  serving: d.overview.serving.map((x) => `${x.email} (${x.why}, ${Math.round((Date.now() - x.lastAt) / 1000)}s ago)`),
  target: d.overview.target?.email ?? null,
  claimable: d.overview.claimable.map((c) => `${c.email} ${c.resets.map((r) => r.name).join(', ')}`),
  accounts: d.accounts.map((a) => ({
    email: a.email,
    plan: a.plan?.label ?? null,
    priority: a.routing.priority,
    role: a.routing.role.kind,
    atWall: a.atWall,
    limits: a.limits.map((l) => `${l.label} ${l.phase === 'open' ? `${l.left}% left` : l.phase} (${l.source.kind})`),
    offers: a.offers.map((o) => `${o.program}: ${o.state.kind}`),
    anthropic: (['limits', 'cedar', 'juniper', 'profile'] as const).map((k) => {
      const f = s.feeds[a.id]?.[k];
      return `${k}: ${f?.last ? 'ok' : f?.error ? `${f.error.value.kind}${f.error.value.kind === 'rate_limited' ? ` until ${new Date(f.error.value.retryAt).toLocaleTimeString()}` : ''}` : 'not yet'}`;
    }),
  })),
};
console.log(JSON.stringify(summary, null, 2));

const foreign = await fetch(`${URL}/api/snapshot`, { headers: { Host: `evil.example:${PORT}` } });
console.log(`guard: foreign Host -> ${foreign.status} (expected 421)`);

mkdirSync(join(ROOT, 'var/screenshots'), { recursive: true });
const pageErrors: string[] = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  await page.goto(URL);
  await page.waitForSelector('[data-testid="overview"]');
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: join(ROOT, SHOT), fullPage: true });
} finally {
  await browser.close();
}
console.log(`screenshot: ${SHOT}`);
console.log(`page errors: ${pageErrors.length}`);
for (const e of pageErrors) console.log(`  ${e}`);

process.exit(foreign.status === 421 && pageErrors.length === 0 ? 0 : 1);
