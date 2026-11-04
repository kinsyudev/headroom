import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import type { Snapshot } from '../src/shared/domain';
import { startStack } from './fake-stack';

const ROOT = join(import.meta.dir, '..');
const SHOTS = join(ROOT, 'var/screenshots');
const ACC1 = 'db7530a6fb8c3450';
const ACC2 = '979fe1390e4d50a9';
const ACC3 = '77d7097981c81ee1';
const FILE1 = 'claude-92802d49-account1@example.com.json';
const FILE2 = 'claude-793879e9-account2@example.com.json';
const ORG3 = '00000000-0000-4000-8000-282a25e894f0';

const EXPECTED_MUTATIONS = [
  { method: 'PATCH', path: '/auth-files/status', body: { name: FILE2, disabled: true } },
  { method: 'PATCH', path: '/auth-files/status', body: { name: FILE2, disabled: false } },
  { method: 'PATCH', path: '/auth-files/fields', body: { name: FILE2, priority: 60 } },
  { method: 'PATCH', path: '/auth-files/fields', body: { name: FILE1, priority: 60 } },
  { method: 'POST', path: '/reset-quota', body: { auth_index: ACC3 } },
  { method: 'POST', path: '/auth-files/refresh', body: { name: FILE1 } },
  { method: 'PUT', path: '/routing/strategy', body: { value: 'round-robin' } },
  { method: 'POST', path: `api-call /api/organizations/${ORG3}/reset_rate_limits`, body: { auth_index: ACC3, program: 'juniper_tide' } },
  { method: 'POST', path: '/reset-quota', body: { auth_index: ACC3 } },
];

const steps: { step: string; ms: number }[] = [];
const t0 = Date.now();
function pass(step: string): void {
  steps.push({ step, ms: Date.now() - t0 });
  console.log(`  ✓ ${step}`);
}
function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
}
async function until(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(250);
  }
}
const text = async (l: Locator) => ((await l.textContent()) ?? '').replace(/\s+/g, ' ').trim();

mkdirSync(SHOTS, { recursive: true });
const stack = await startStack({ port: 18_338, log: join(ROOT, 'var/e2e-app.log') });
assert(!stack.fake.url.endsWith(':8317'), 'never the real CPA');
const browser = await chromium.launch();
const pageErrors: string[] = [];
let failed = false;

try {
  const page: Page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  const snapshot = async () => (await (await fetch(`${stack.url}/api/snapshot`)).json()) as Snapshot;
  const card = (email: string) => page.getByTestId(`card-${email}`);
  const mutations = () => stack.fake.mutations;

  console.log(`deck ${stack.url} · fake CPA ${stack.fake.url}`);
  await page.goto(stack.url);
  await until(async () => Object.values((await snapshot()).feeds).filter((f) => f.limits.last && f.profile.last).length === 3, 'first Anthropic reads for all three accounts', 120_000);
  await until(async () => (await page.getByTestId('offer-juniper_tide').filter({ hasText: 'Claimable' }).count()) === 1, 'account3 wall read shows a claimable reset');
  pass('three accounts read through the budgeted scheduler');

  assert((await page.locator('[data-testid^="card-"]').count()) === 3, 'three account cards');
  assert((await text(page.getByTestId('tile-serving'))).includes('account1@example.com'), 'overview names account1 as serving');
  assert(/\d+h \d+m|\d+m/.test(await text(page.getByTestId('tile-next-reset').locator('.hero'))), 'next reset countdown');
  assert((await text(page.getByTestId('tile-claimable').locator('.hero'))) === '2', 'two claimable resets');
  assert(/\d\.\d\d of 3/.test(await text(page.getByTestId('tile-headroom'))), 'headroom in accounts worth');
  const pct = async (email: string, key: string) => text(card(email).getByTestId(`limit-${key}`).getByTestId('percent'));
  assert((await pct('account1@example.com', 'session')) === '12%', 'account1 session 12% from the poll');
  assert((await pct('account1@example.com', 'weekly_all')) === '27%', 'account1 weekly 27%');
  assert((await pct('account2@example.com', 'session')) === 'idle', 'account2 has no session window');
  assert((await pct('account2@example.com', 'weekly_all')) === '1%', 'account2 weekly 1%');
  assert((await pct('account3@example.com', 'session')) === '100%', 'account3 session at the wall');
  assert((await text(card('account3@example.com').getByTestId('role'))).startsWith('■ Blocked'), 'account3 blocked');
  assert((await text(card('account2@example.com').getByTestId('freshness'))).includes('weekly reset'), 'freshness line names the held weekly reset read');
  await page.screenshot({ path: join(SHOTS, 'e2e-1-loaded.png'), fullPage: true });
  pass('overview and three cards render with real numbers');
  assert(mutations().length === 0, 'loading the page mutates nothing');

  async function step(name: string, click: () => Promise<void>, count: number, check: () => Promise<void>) {
    const n = mutations().length;
    await click();
    await until(() => mutations().length >= n + count, `${name}: ${count} mutation(s) reach CPA`);
    await check();
    pass(name);
  }

  const c2 = card('account2@example.com');
  await step('disable account2', () => c2.getByTestId('toggle-disabled').click(), 1, async () => {
    await c2.getByTestId('role').filter({ hasText: 'Disabled' }).waitFor();
    await c2.locator('.feedback.ok', { hasText: 'disabled' }).waitFor();
  });
  await step('enable account2', () => c2.getByTestId('toggle-disabled').click(), 1, async () => {
    await c2.getByTestId('toggle-disabled').filter({ hasText: 'Disable' }).waitFor();
    await until(async () => !(await text(c2.getByTestId('role'))).includes('Disabled'), 'account2 enabled');
  });
  await step('make account2 primary', () => c2.getByTestId('make-primary').click(), 1, async () => {
    await c2.getByTestId('priority').filter({ hasText: '60' }).waitFor();
    await c2.locator('.feedback.ok', { hasText: 'priority 60' }).waitFor();
  });
  const c1 = card('account1@example.com');
  await step('raise account1 priority by 10', () => c1.getByTestId('priority-up').click(), 1, async () => {
    await c1.getByTestId('priority').filter({ hasText: '60' }).waitFor();
    await c1.locator('.feedback.ok', { hasText: 'saved' }).waitFor();
  });
  const c3 = card('account3@example.com');
  await step('clear account3 cooldown', () => c3.getByTestId('clear-cooldown').click(), 1, async () => {
    await until(async () => (await c3.locator('.cooldown').count()) === 0, 'cooldown gone from the card');
    await until(async () => !(await text(c3.getByTestId('role'))).includes('Blocked'), 'account3 no longer blocked');
  });
  await step('refresh account1 token', () => c1.getByTestId('refresh-token').click(), 1, async () => {
    await c1.locator('.feedback.ok', { hasText: 'token refreshed' }).waitFor();
  });
  await step('switch routing to round-robin', () => page.getByTestId('strategy-round-robin').click(), 1, async () => {
    await until(async () => (await page.getByTestId('strategy-round-robin').isDisabled()) && (await page.getByTestId('strategy-fill-first').isEnabled()), 'round-robin active');
  });

  await c3.getByTestId('claim-juniper_tide').click();
  const dialog = page.getByTestId('claim-dialog');
  await dialog.waitFor();
  const facts = await text(dialog);
  for (const s of ['account3@example.com', 'Team · Max 5x', 'Weekly session reset', 'juniper_tide', 'Clears the session (5h) limit now', 'This cannot be undone']) {
    assert(facts.includes(s), `claim dialog names "${s}"`);
  }
  assert((await text(dialog.getByTestId('claim-confirm'))) === 'Reset session limit on account3@example.com', 'confirm button names account and effect');
  await page.screenshot({ path: join(SHOTS, 'e2e-2-claim-dialog.png') });
  pass('claim dialog names account, program and effect');
  await step(
    'claim juniper_tide on account3 through the dialog',
    async () => {
      await dialog.getByTestId('claim-confirm').click();
      await dialog.getByTestId('claim-confirm').filter({ hasText: 'Claiming…' }).waitFor();
    },
    2,
    async () => {
      const result = dialog.getByTestId('claim-result');
      await result.waitFor({ timeout: 90_000 });
      const t = await text(result);
      assert(t.startsWith('Reset.') && t.includes('CPA cooldown cleared'), `claim result reads "${t}"`);
    },
  );
  await page.screenshot({ path: join(SHOTS, 'e2e-3-claim-result.png') });
  await dialog.getByTestId('claim-close').click();
  const settledOffer = await text(c3.getByTestId('offer-juniper_tide'));
  assert(!settledOffer.includes('Claimable') && /Claimed|Next at/.test(settledOffer), `before the next read the used offer reads "${settledOffer}"`);
  pass('a settled claim never shows the old offer as claimable');
  await until(async () => (await text(c3.getByTestId('offer-juniper_tide'))).includes('Next at'), 'the wall read a minute after the claim shows the reset as used', 120_000);
  await until(async () => (await text(page.getByTestId('tile-claimable').locator('.hero'))) === '0', 'overview drops the used resets');
  pass('post-claim wall read shows the weekly reset as used and the overview drops it');

  const reads = () => stack.fake.calls.filter((c) => c.account === ACC1 && c.path.startsWith('/api/oauth/usage')).length;
  const before = reads();
  await c1.getByTestId('refresh-quota').click({ timeout: 70_000 });
  await until(() => reads() === before + 1, 'Read now sends exactly one usage read for account1', 40_000);
  pass('read now sends one budgeted usage read and no mutation');

  const foreign = await fetch(`${stack.url}/api/snapshot`, { headers: { Host: `evil.example:${stack.port}` } });
  assert(foreign.status === 421, `foreign Host answered ${foreign.status}`);
  const bare = await fetch(`${stack.url}/api/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'routing.setStrategy', input: { strategy: 'fill-first' } }) });
  assert(bare.status === 403, `POST without X-Headroom answered ${bare.status}`);
  pass('guard rejects a foreign Host (421) and a POST without X-Headroom (403)');

  const got = mutations().map((m) => ({ method: m.method, path: m.path, body: m.body }));
  assert(Bun.deepEquals(got, EXPECTED_MUTATIONS), `mutations differ:\n${JSON.stringify(got, null, 2)}`);
  pass(`fake CPA recorded exactly the ${EXPECTED_MUTATIONS.length} expected mutations`);
  const identity = new Set(stack.fake.calls.map((c) => `${c.userAgent}|${c.xApp}`));
  assert(identity.size === 1 && [...identity][0] === 'claude-cli/2.1.311 (external, cli)|cli', 'every Anthropic call carried the Claude Code identity');
  const starts = stack.fake.calls.map((c) => c.at).sort((a, b) => a - b);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  assert(Math.min(...gaps) >= 9_900, `Anthropic calls at least 10 s apart (min gap ${Math.min(...gaps)} ms)`);
  pass(`${stack.fake.calls.length} Anthropic calls, all with the Claude Code identity, min gap ${(Math.min(...gaps) / 1000).toFixed(1)} s`);

  await page.getByTestId('history').scrollIntoViewIfNeeded();
  const bars = page.locator('.chart rect[tabindex="0"]');
  await bars.nth((await bars.count()) - 1).hover();
  await page.locator('.tooltip').waitFor();
  await page.getByTestId('history').screenshot({ path: join(SHOTS, 'e2e-4-history-hover.png') });
  pass('history chart answers hover with every series');

  const popup = page.waitForEvent('popup');
  await page.getByTestId('add-account').click();
  await (await popup).waitForLoadState();
  await page.getByTestId('oauth-flow').and(page.locator('[data-status="ok"]')).waitFor({ timeout: 30_000 });
  await card('account4@example.com').waitFor({ timeout: 15_000 });
  pass('add account: OAuth flow completes and a fourth card appears');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(SHOTS, 'e2e-5-after-actions.png'), fullPage: true });
  assert(pageErrors.length === 0, `browser errors: ${pageErrors.join(' | ')}`);
  pass('no browser errors');
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.message : e);
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (pages[0]) await pages[0].screenshot({ path: join(SHOTS, 'e2e-failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  writeFileSync(join(ROOT, 'var/e2e-report.json'), JSON.stringify({ failed, steps, mutations: stack.fake.mutations, anthropicCalls: stack.fake.calls.length, pageErrors }, null, 2));
  await browser.close();
  await stack.stop();
}
console.log(failed ? 'E2E FAILED' : `E2E PASSED in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
