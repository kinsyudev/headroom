import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Snapshot } from '../src/shared/domain';
import { startStack } from './fake-stack';

// Renders the page in a fixed set of states against the fake CPA, for design review.
// Usage: bun scripts/ui-shots.ts <outdir> [--port 18339] [--css extra.css]

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'var/ui-shots');
const port = Number(flag('--port') ?? 18_339);
const extraCss = flag('--css') ? readFileSync(resolve(flag('--css')!), 'utf8') : undefined;
const TILE = 1000;
const MAX_TILES = 5;

mkdirSync(out, { recursive: true });
const shots: { file: string; what: string }[] = [];
const errors: string[] = [];
const pageErrors: string[] = [];

const stack = await startStack({ port, log: join(out, 'app.log') });
if (stack.fake.url.endsWith(':8317')) throw new Error('never the real CPA');
const browser = await chromium.launch();
const context: BrowserContext = await browser.newContext({ deviceScaleFactor: 1 });
if (extraCss) await context.addInitScript((css) => document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: css }))), extraCss);

async function until(cond: () => Promise<boolean>, what: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > end) {
      errors.push(`timed out: ${what}`);
      return false;
    }
    await Bun.sleep(250);
  }
  return true;
}

async function open(width: number, height: number, ctx: BrowserContext = context): Promise<Page> {
  const page = await ctx.newPage();
  await page.setViewportSize({ width, height });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  await page.goto(stack.url);
  await until(async () => (await page.locator('[data-testid^="card-"]').count()) >= 3, 'three account cards', 30_000);
  await page.waitForTimeout(1_500);
  return page;
}

async function tiles(page: Page, name: string, what: string): Promise<void> {
  const viewport = page.viewportSize()!;
  // A fullPage capture resizes the window mid-shot, and the chart redraws blank on that resize; settle at full height first.
  await page.setViewportSize({ width: viewport.width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
  await page.waitForTimeout(600);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const n = Math.min(MAX_TILES, Math.ceil(height / TILE));
  for (let i = 0; i < n; i++) {
    const file = `${name}-${i + 1}.png`;
    await page.screenshot({ path: join(out, file), clip: { x: 0, y: i * TILE, width: viewport.width, height: Math.min(TILE, height - i * TILE) } });
    shots.push({ file, what: `${what}, part ${i + 1} of ${n} (page is ${height}px tall)` });
  }
  await page.setViewportSize(viewport);
}

async function shot(name: string, what: string, take: (path: string) => Promise<unknown>): Promise<void> {
  const file = `${name}.png`;
  try {
    await take(join(out, file));
    shots.push({ file, what });
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

try {
  const snapshot = async () => (await (await fetch(`${stack.url}/api/snapshot`)).json()) as Snapshot;
  await until(async () => Object.values((await snapshot()).feeds).filter((f) => f.limits.last && f.profile.last).length === 3, 'first Anthropic reads for all three accounts', 150_000);

  const desk = await open(1480, TILE);
  await until(async () => (await desk.getByTestId('claim-juniper_tide').count()) === 1, 'account3 shows a claimable reset', 60_000);
  await desk.waitForTimeout(1_000);
  await tiles(desk, 'desktop', 'Whole page at 1480px wide, scrolled top to bottom');

  await shot('brand', 'The page header at 1480px wide, captured at 2x pixel density so the name and mark are crisp', async (path) => {
    const sharp = await browser.newContext({ deviceScaleFactor: 2 });
    const page = await open(1480, TILE, sharp);
    await page.screenshot({ path, clip: { x: 0, y: 0, width: 1480, height: 140 } });
    await sharp.close();
  });

  const views = async (page: Page, name: string, what: string) => {
    if ((await page.getByTestId('nav-analytics').count()) > 0) {
      await page.getByTestId('nav-analytics').first().click();
      await page.waitForTimeout(1_500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await tiles(page, name, `${what}, after opening the analytics view from its navigation`);
    } else if ((await page.getByTestId('analytics').count()) > 0) {
      await page.getByTestId('analytics').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await shot(name, `${what}: the analytics section on the page`, (path) => page.getByTestId('analytics').first().screenshot({ path }));
    }
  };
  const analyticsDesk = await open(1480, TILE);
  await views(analyticsDesk, 'analytics', 'Analytics at 1480px wide');
  await analyticsDesk.close();
  const analyticsHalf = await open(760, TILE);
  await views(analyticsHalf, 'analytics-half', 'Analytics in a half-width 760px window');
  await analyticsHalf.close();

  const laptop = await open(1280, 800);
  await shot('laptop-fold', 'What a 1280x800 laptop window shows on open, before any scrolling', (path) => laptop.screenshot({ path }));
  await laptop.close();

  const half = await open(760, TILE);
  await tiles(half, 'half', 'Whole page in a half-width 760px window, scrolled top to bottom');
  await half.close();

  await desk.evaluate(() => window.scrollTo(0, 0));
  await shot('claim-dialog', 'The confirmation dialog after clicking Claim on account3 weekly session reset (not confirmed)', async (path) => {
    await desk.getByTestId('claim-juniper_tide').click();
    await desk.getByTestId('claim-dialog').waitFor({ timeout: 5_000 });
    await desk.waitForTimeout(300);
    await desk.screenshot({ path });
    await desk.keyboard.press('Escape');
  });

  const c2 = desk.getByTestId('card-account2@example.com');
  await shot('action-feedback', 'account2 card about 1 s after clicking +10 priority (success feedback)', async (path) => {
    await c2.getByTestId('priority-up').click();
    await c2.locator('[data-state="ok"], .feedback.ok').first().waitFor({ timeout: 15_000 });
    await desk.waitForTimeout(300);
    await c2.screenshot({ path });
  });

  await shot('history-hover', 'History panel with the pointer on the latest bar', async (path) => {
    await desk.getByTestId('history').scrollIntoViewIfNeeded();
    const bars = desk.locator('.chart rect[tabindex="0"]');
    await bars.nth((await bars.count()) - 1).hover();
    await desk.locator('.tooltip').waitFor({ timeout: 5_000 });
    await desk.getByTestId('history').screenshot({ path });
  });

  stack.fake.authDelayMs = 15_000;
  await desk.mouse.move(0, 0);
  await desk.evaluate(() => window.scrollTo(0, 0));
  await until(async () => (await desk.getByRole('alert').filter({ hasText: /CPA/ }).count()) > 0, 'CPA-unreachable warning shows', 90_000);
  await desk.waitForTimeout(1_000);
  await shot('cpa-down', 'Top of the page at 1480px after CPA stopped answering (CPA unreachable)', (path) => desk.screenshot({ path }));
  stack.fake.authDelayMs = 0;
} catch (e) {
  errors.push(`aborted: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
} finally {
  await browser.close();
  await stack.stop();
}

const missing = shots.filter((s) => !existsSync(join(out, s.file)) || statSync(join(out, s.file)).size < 5_000);
for (const s of missing) errors.push(`${s.file} missing or blank`);
const git = (cmd: string[]) => Bun.spawnSync(['git', ...cmd], { cwd: join(import.meta.dir, '..') }).stdout.toString().trim();
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify({ at: new Date().toISOString(), commit: git(['rev-parse', '--short', 'HEAD']), dirty: git(['status', '--porcelain', '--', 'src']) !== '', extraCss: Boolean(extraCss), shots, errors, pageErrors }, null, 2),
);
console.log(`shots=${shots.length} errors=${errors.length} pageErrors=${pageErrors.length} out=${out}`);
for (const e of [...errors, ...pageErrors]) console.log(`  ${e}`);
process.exit(errors.length + pageErrors.length > 0 ? 1 : 0);
