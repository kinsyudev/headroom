import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import type { Snapshot } from '../src/shared/domain';
import { FAKE_CLI_VERSION, startStack } from './fake-stack';

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
/** A time as clockTime prints it: "19:25" today, "Fri 00:23" on another day. The fake's resets follow the wall clock, so late in the day they fall after midnight. */
const CLOCK = String.raw`(?:[A-Z][a-z]{2} )?\d\d:\d\d`;

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
  await until(async () => (await page.getByTestId('claim-juniper_tide').count()) === 1, 'account3 wall read shows a claimable reset');
  pass('three accounts read through the budgeted scheduler');

  assert((await page.locator('[data-testid^="card-"]').count()) === 3, 'three account cards');
  // The keep-alive keeps account1 serving, but account2 or account3 may have answered after it, so the latest request may name any of them.
  const servingTile = page.getByTestId('tile-serving');
  assert(
    (await text(servingTile.getByTestId('serving-new'))) === 'New sessions go to' && (await text(servingTile.locator('.hero-text'))) === 'account1@example.com',
    'overview names account1 as the account new sessions go to',
  );
  const latest = await text(servingTile.getByTestId('serving-latest'));
  assert(/^Latest request account[123] · \d+[sm] ago$/.test(latest), `overview names the account that answered the latest request and how long ago: "${latest}"`);
  assert((await text(card('account1@example.com').getByTestId('role'))) === '● New sessions', "account1's row chip says it serves and takes new sessions, as the tile does");
  assert(
    (await page.locator('[data-testid="role"]').allTextContents()).every((t) => !t.includes('Serving') && !t.includes('Serves')),
    'no row chip uses a second word for serving: an account is New sessions, Active, Standby, Blocked or Disabled',
  );
  assert(await card('account1@example.com').getByTestId('make-primary').isHidden(), 'the account that already serves first offers no Serve first button');
  assert(
    /^Raise priority from 10 to 60, ten above the highest other account, so new sessions go here first$/.test((await card('account2@example.com').getByTestId('make-primary').getAttribute('title')) ?? ''),
    "Serve first on account2 says what it does to priority",
  );
  assert(/\d+h \d+m|\d+m/.test(await text(page.getByTestId('tile-next-reset').locator('.hero'))), 'next reset countdown');
  assert((await text(page.getByTestId('tile-claimable').locator('.hero'))) === '2', 'two claimable resets');
  const verdict = await text(page.getByTestId('tile-claimable').getByTestId('claim-verdict'));
  const panelVerdict = await text(card('account3@example.com').getByTestId('claim-verdict'));
  assert(
    verdict === 'Not needed now: account1 and account2 have room' && new RegExp(`^${verdict}; account3 is back at ${CLOCK}$`).test(panelVerdict),
    `the Claimable tile and account3's claim panel say in one line why a claim is not needed now, and the panel when account3 is back: "${verdict}" / "${panelVerdict}"`,
  );
  const nextReset = await text(page.getByTestId('tile-next-reset').getByTestId('next-reset'));
  assert(new RegExp(`^account3 session resets ${CLOCK}$`).test(nextReset) && !(await text(page.getByTestId('tile-next-reset'))).includes('Blocked'), 'next reset says only the reset: account3 session, with no Blocked chip');
  const runOut = page.getByTestId('tile-next-reset').getByTestId('run-out');
  const runOutTitle = (await runOut.getAttribute('title')) ?? '';
  assert(
    new RegExp(String.raw`^! account1 session runs out ~${CLOCK} · in (\d+h )?\d+m$`).test(await text(runOut)) &&
      new RegExp(String.raw`^account1 session runs out ~${CLOCK}, (\d+h )?\d+m before its ${CLOCK} reset\. New sessions then go to account2\.`).test(runOutTitle),
    `the strip warns in one line that account1's session runs out, and its tooltip says how long before the reset and that account2 takes over: "${await text(runOut)}" / "${runOutTitle}"`,
  );
  // account2 may have answered in the last 2 min, so its word follows its own row chip: Active or Standby.
  const word2 = (await text(card('account2@example.com').getByTestId('role'))).includes('Active') ? 'active' : 'standby';
  const order = await text(page.getByTestId('tile-headroom'));
  assert(
    new RegExp(`^Serve order 1 account1 taking new sessions\\s*2 account2 ${word2}\\s*– account3 blocked until ${CLOCK}$`).test(order),
    `serve order: account1 then account2 by priority, each with the one word its row chip says and no percentages, then account3 out, blocked until its session reset frees it: "${order}"`,
  );
  const runsOut = await text(card('account1@example.com').getByTestId('limit-session').getByTestId('pace-note'));
  assert(
    new RegExp(String.raw`^! Runs out ~${CLOCK} · in (\d+h )?\d+m$`).test(runsOut) && runsOut.slice('! Runs out '.length) === (await text(runOut)).slice('! account1 session runs out '.length),
    `account1's session cell warns it runs out before its reset, in the strip's own words: "${runsOut}"`,
  );
  assert((await runOut.getAttribute('href')) === `#usage/pace-${ACC1}-session`, "the strip's runs-out line links to account1's session pace row in Usage");
  const usageTab = page.getByTestId('nav-analytics');
  const tabCount = usageTab.locator('.tab-count');
  assert(
    (await text(usageTab)) === 'Usage1 quota window runs out before its reset' &&
      (await text(tabCount)) === '1' &&
      ((await tabCount.getAttribute('title')) ?? '').startsWith('account1 session runs out ~'),
    "while pace says one window runs out, the Usage tab carries a count of 1 whose tooltip names account1's session",
  );
  const ledgerHeads = (await page.locator('.ledger-head > span').allTextContents()).join('|');
  assert(
    /^Account\|Session left\|Weekly left\|Requests · last (\d+h )?\d+m$/.test(ledgerHeads),
    `each quota column says once, in its header, that it counts what is left, and Requests names its window there: "${ledgerHeads}"`,
  );
  assert(
    (await text(card('account1@example.com').getByTestId('limit-weekly_all').getByTestId('limit-weekly_scoped:Fable'))) === 'Fable 92%',
    "Fable's weekly window resets with Weekly, so it is a second line in the Weekly cell instead of a column",
  );
  assert(
    (await text(card('account1@example.com').getByTestId('spend'))) === 'Extra usage off' && (await text(card('account2@example.com').getByTestId('spend'))) === 'Extra usage off',
    'with no account spending extra usage it takes no column, and each plan line says it is off',
  );
  const capChip = await text(card('account3@example.com').getByTestId('spend'));
  assert(/^✕\s*Extra usage cap reached · resets (.+ )?\d\d:\d\d$/.test(capChip), `account3's plan line says its extra-usage cap is reached and when it resets: "${capChip}"`);
  assert(
    /^Even-pace mark: \d+% of the window gone$/.test((await card('account1@example.com').getByTestId('limit-session').locator('.meter-tick').getAttribute('title')) ?? ''),
    "the tick on account1's session bar says on hover how much of the window is gone",
  );
  assert(
    (await text(page.locator('.ledger-key'))) === 'The bar is what is left. The tick is where it would stand if you used the window evenly. A fill that ends left of the tick means you are using it faster than that.',
    'one legend line under the account table explains the tick in the shared wording',
  );
  const pct = async (email: string, key: string) => text(card(email).getByTestId(`limit-${key}`).getByTestId('percent'));
  assert((await pct('account1@example.com', 'session')) === '88%', 'account1 session 88% left from the poll');
  assert((await pct('account1@example.com', 'weekly_all')) === '73%', 'account1 weekly 73% left');
  assert((await pct('account2@example.com', 'session')) === '100%', 'account2 session is all left');
  assert((await text(card('account2@example.com').getByTestId('limit-session'))).includes('starts on first request'), 'account2 has no session window');
  assert((await pct('account2@example.com', 'weekly_all')) === '99%', 'account2 weekly 99% left');
  assert((await pct('account3@example.com', 'session')) === '0%', 'account3 session at the wall has nothing left');
  assert((await text(card('account3@example.com').getByTestId('role'))).startsWith('■ Blocked'), 'account3 blocked');
  assert(((await card('account2@example.com').getByTestId('freshness').getAttribute('title')) ?? '').includes('weekly reset: held'), 'freshness tooltip names the held weekly reset read');
  const checkedLine = await text(page.getByTestId('checked'));
  const rowStamps = await Promise.all(['account1', 'account2', 'account3'].map(async (n) => text(card(`${n}@example.com`).getByTestId('freshness'))));
  assert(
    /^Quota checked (\d+ to )?\d+[sm] ago$|^Quota checked \d+[sm] to \d+[sm] ago$/.test(checkedLine) && rowStamps.every((t) => !t.includes('checked')),
    `the account table header says once when quota was checked, and no row on time repeats it: "${checkedLine}" / ${rowStamps.join(' | ')}`,
  );
  const marker = (scope: Locator) => scope.locator('.swatch').first().getAttribute('data-shape');
  const shapes = await Promise.all(['account1', 'account2', 'account3'].map((n) => marker(card(`${n}@example.com`))));
  assert(new Set(shapes).size === 3 && shapes.every(Boolean), `each account card marks the account with a shape of its own beside its colour: ${shapes.join(', ')}`);
  await page.screenshot({ path: join(SHOTS, 'e2e-1-loaded.png'), fullPage: true });
  pass('overview and three cards render with real numbers');

  const more = card('account1@example.com').getByTestId('more-actions');
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  await more.focus();
  await page.keyboard.press('ArrowDown');
  assert((await more.getAttribute('aria-expanded')) === 'true' && (await focused()) === 'refresh-quota', 'ArrowDown on More opens the menu on its first action');
  await page.keyboard.press('ArrowDown');
  assert((await focused()) === 'refresh-token', 'ArrowDown moves to the next action');
  await page.keyboard.press('End');
  assert((await focused()) === 'toggle-disabled', 'End moves to Disable, the last action');
  await page.keyboard.press('ArrowDown');
  assert((await focused()) === 'refresh-quota', 'ArrowDown past the last action wraps to the first');
  await page.keyboard.press('Escape');
  assert((await more.getAttribute('aria-expanded')) === 'false' && (await focused()) === 'more-actions' && (await card('account1@example.com').getByTestId('refresh-token').count()) === 0, 'Escape closes the menu and returns focus to More');
  pass('each row keeps its rare actions in a More menu that works by keyboard');
  assert(mutations().length === 0, 'loading the page mutates nothing');

  async function step(name: string, click: () => Promise<void>, count: number, check: () => Promise<void>) {
    const n = mutations().length;
    await click();
    await until(() => mutations().length >= n + count, `${name}: ${count} mutation(s) reach CPA`);
    await check();
    pass(name);
  }

  const c2 = card('account2@example.com');
  const fromMore = async (row: Locator, testId: string, timeout?: number) => {
    await row.getByTestId('more-actions').click();
    await row.getByTestId(testId).click(timeout === undefined ? undefined : { timeout });
  };
  await step('disable account2', () => fromMore(c2, 'toggle-disabled'), 1, async () => {
    await c2.getByTestId('role').filter({ hasText: 'Disabled' }).waitFor();
    await c2.locator('.feedback.ok', { hasText: 'disabled' }).waitFor();
  });
  await step('enable account2', () => c2.getByTestId('toggle-disabled').filter({ hasText: 'Enable' }).click(), 1, async () => {
    await until(async () => !(await text(c2.getByTestId('role'))).includes('Disabled'), 'account2 enabled');
    await c2.getByTestId('more-actions').click();
    await c2.getByTestId('toggle-disabled').filter({ hasText: 'Disable' }).waitFor();
    await page.keyboard.press('Escape');
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
  await step('refresh account1 token', () => fromMore(c1, 'refresh-token'), 1, async () => {
    await c1.locator('.feedback.ok', { hasText: 'token refreshed' }).waitFor();
  });
  await step('switch routing to round-robin', () => page.getByTestId('strategy-round-robin').click(), 1, async () => {
    await until(async () => (await page.getByTestId('strategy-round-robin').isDisabled()) && (await page.getByTestId('strategy-fill-first').isEnabled()), 'round-robin active');
  });

  assert(
    (await text(c3.getByTestId('claim-juniper_tide'))) === 'Claim weekly…' && (await text(c3.getByTestId('claim-cedar_ember'))) === 'Claim bonus…',
    'each Claim button names its reset',
  );
  const dialog = page.getByTestId('claim-dialog');
  await c3.getByTestId('claim-cedar_ember').click();
  await dialog.waitFor();
  assert((await text(dialog.getByTestId('claim-confirm'))) === 'Claim bonus session reset on account3', 'from the bonus row the confirm button names the bonus reset');
  await dialog.getByTestId('claim-close').click();
  await dialog.waitFor({ state: 'detached' });
  await c3.getByTestId('claim-juniper_tide').click();
  await dialog.waitFor();
  const facts = await text(dialog);
  for (const s of ['account3@example.com', 'Team · Max 5x', 'Session reset · weekly', 'Clears the session (5h) limit now', 'This cannot be undone']) {
    assert(facts.includes(s), `claim dialog names "${s}"`);
  }
  assert(!facts.includes('juniper_tide'), 'claim dialog shows no raw program code');
  assert((await dialog.locator('#claim-name').getAttribute('title')) === 'juniper_tide', 'claim dialog keeps the program code in the name title');
  assert((await text(dialog.getByTestId('claim-confirm'))) === 'Claim weekly session reset on account3', 'confirm button names the reset the operator clicked, what it clears and the account');
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
  assert((await c3.getByTestId('claim-juniper_tide').count()) === 0 && /Claimed|Next at/.test(settledOffer), `before the next read the used offer reads "${settledOffer}" and has no Claim button`);
  pass('a settled claim never shows the old offer as claimable');
  await until(async () => (await text(c3.getByTestId('offer-juniper_tide'))).includes('Next at'), 'the wall read a minute after the claim shows the reset as used', 120_000);
  await until(async () => (await text(page.getByTestId('tile-claimable').locator('.hero'))) === '0', 'overview drops the used resets');
  pass('post-claim wall read shows the weekly reset as used and the overview drops it');

  const reads = () => stack.fake.calls.filter((c) => c.account === ACC1 && c.path.startsWith('/api/oauth/usage')).length;
  const before = reads();
  await fromMore(c1, 'refresh-quota', 70_000);
  await until(() => reads() === before + 1, 'Check now sends exactly one usage read for account1', 40_000);
  pass('check now sends one budgeted usage read and no mutation');

  const foreign = await fetch(`${stack.url}/api/snapshot`, { headers: { Host: `evil.example:${stack.port}` } });
  assert(foreign.status === 421, `foreign Host answered ${foreign.status}`);
  const bare = await fetch(`${stack.url}/api/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'routing.setStrategy', input: { strategy: 'fill-first' } }) });
  assert(bare.status === 403, `POST without X-Headroom answered ${bare.status}`);
  pass('guard rejects a foreign Host (421) and a POST without X-Headroom (403)');

  const got = mutations().map((m) => ({ method: m.method, path: m.path, body: m.body }));
  assert(Bun.deepEquals(got, EXPECTED_MUTATIONS), `mutations differ:\n${JSON.stringify(got, null, 2)}`);
  pass(`fake CPA recorded exactly the ${EXPECTED_MUTATIONS.length} expected mutations`);
  const identity = new Set(stack.fake.calls.map((c) => `${c.userAgent}|${c.xApp}`));
  assert(identity.size === 1 && [...identity][0] === `claude-cli/${FAKE_CLI_VERSION} (external, cli)|cli`, 'every Anthropic call carried the Claude Code identity');
  const starts = stack.fake.calls.map((c) => c.at).sort((a, b) => a - b);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  assert(Math.min(...gaps) >= 9_900, `Anthropic calls at least 10 s apart (min gap ${Math.min(...gaps)} ms)`);
  pass(`${stack.fake.calls.length} Anthropic calls, all with the Claude Code identity, min gap ${(Math.min(...gaps) / 1000).toFixed(1)} s`);

  await page.getByTestId('history').scrollIntoViewIfNeeded();
  const bars = page.locator('.chart rect[tabindex="0"]');
  await bars.nth((await bars.count()) - 1).hover();
  await page.locator('.tooltip').waitFor();
  assert((await page.locator('.tooltip-title').innerText()).includes('in progress'), 'tooltip on the latest bar says the hour is in progress');
  await page.getByTestId('history').screenshot({ path: join(SHOTS, 'e2e-4-history-hover.png') });
  pass('history chart answers hover on the in-progress hour');

  await card('account1@example.com').getByTestId('pace-note').click();
  const paceRow = page.locator(`[id="pace-${ACC1}-session"]`);
  await paceRow.waitFor();
  assert(page.url().endsWith(`#usage/pace-${ACC1}-session`), "the run-out note links to its window's row in Usage");
  assert(
    (await paceRow.evaluate((el) => el.classList.contains('targeted') && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= window.innerHeight)) &&
      new RegExp(String.raw`Runs out ~${CLOCK} · in (\d+h )?\d+m`).test(await text(paceRow)),
    "the run-out note opens Usage scrolled to account1's session pace row, marked, and saying it runs out",
  );
  pass('the run-out note on a card opens its quota pace row in Usage');

  await page.getByTestId('nav-analytics').click();
  await page.getByTestId('week-strip').waitFor();
  assert(page.url().endsWith('#usage'), 'the Usage tab puts #usage in the address, so the view can be linked');
  assert(/\d/.test(await text(page.getByTestId('kpi-requests').locator('.kpi-value'))), 'the week strip counts the last 7 days of requests');
  assert((await text(page.getByTestId('kpi-top'))).includes('Opus 5.5'), 'the most used model is named in plain words');
  const paceRows = page.getByTestId('pace').locator('.pace-row');
  assert((await paceRows.count()) >= 3, 'the quota pace lists a row per open window');
  assert(/Lasts to the reset|Runs out ~|At its limit|Too early to say/.test(await text(paceRows.first())), 'every pace row ends in one of the four outlooks');
  assert(
    (await page.getByTestId('analytics').locator(':scope > *').evaluateAll((els) => els.slice(0, 3).map((el) => el.getAttribute('data-testid') ?? el.className))).join('|') === 'pace|toolbar|week-strip',
    'Usage opens on the quota pace, then the Explore bar, then the range-driven week strip',
  );
  assert((await text(paceRows.filter({ hasText: 'Lasts to the reset' }).first())).includes('left at the reset'), 'a window that lasts says how much would be left at its reset, in the same left terms as its bar');
  assert(
    (await text(page.getByTestId('pace').locator('.pace-key'))).includes('The bar is what is left. The tick is where it would stand if you used the window evenly. A fill that ends left of the tick means you are using it faster than that.'),
    'the pace footnote uses the shared tick wording',
  );
  const folds = page.getByTestId('pace').locator('.pace-fold');
  assert((await folds.count()) === 3 && (await folds.evaluateAll((els) => els.every((el) => !(el as HTMLDetailsElement).open))), 'each account whose windows last folds them into one line, closed on open');
  const foldLine = await text(folds.nth(1).locator('summary'));
  assert(
    /^account2\s*Weekly 99% left resets .+Weekly · Fable 100% left resets .+Both last to the reset/.test(foldLine),
    `a folded line keeps each window's percent left and reset time, and says whether they last: "${foldLine}"`,
  );
  const lasting = paceRows.filter({ hasText: 'Lasts to the reset' }).first();
  assert(!(await lasting.isVisible()), 'a window that lasts keeps its bar out of sight while its line is closed');
  await folds.first().locator('summary').click();
  assert(await lasting.isVisible(), "opening a line shows each of its windows' full rows");
  await folds.first().locator('summary').click();
  assert(
    await page.getByTestId('week-strip').locator('.kpis').evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY <= window.innerHeight),
    'the headline row sits inside the first screen at 1480 × 1000, because a healthy account costs the quota pace one line',
  );
  assert((await page.locator('[data-testid="week-pattern"] rect.cell').count()) === 7 * 24, 'the weekday-by-hour grid has a cell for each of the 168 slots');
  assert((await text(page.getByTestId('kpi-requests'))).includes('vs the 7 days before'), 'Usage opens on 7 days, and the requests tile compares them with the 7 days before');
  const legend = page.getByTestId('over-time').getByRole('list', { name: 'Legend' });
  const legendText = await text(legend);
  assert(
    (await legend.locator('li').count()) === 4 && ['account1', 'account2', 'account3', 'Same day last week'].every((s) => legendText.includes(s)) && !legendText.includes('@'),
    'the over-time legend names the three accounts by their short names, with no email, and the same day last week',
  );
  const legendShape = (name: string) => marker(legend.locator('li', { hasText: name }));
  assert((await Promise.all(['account1', 'account2', 'account3'].map(legendShape))).join() === shapes.join(), 'the over-time legend marks each account with the shape its card wears');
  assert((await page.getByTestId('over-time').locator('.chart rect[tabindex="0"]').count()) === 7, 'the opening 7 days draw seven days, the last one still filling');
  const levels = page.getByTestId('over-time').locator('.chart .prev-level');
  assert((await levels.count()) === 7, 'each of the seven days carries its same-day-last-week level mark');
  assert((await levels.evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height <= 6))), 'last week reads as a thin level across its column, not as a box');
  await page.getByTestId('over-time').locator('.chart rect[tabindex="0"]').nth(5).hover();
  const overTip = await text(page.locator('.tooltip'));
  assert(overTip.includes('Same day last week') && overTip.includes('account1') && !overTip.includes('@'), 'hovering a day gives the figure for the same day last week and names accounts by their short names');
  await page.getByTestId('usage-range-30d').click();
  assert((await page.getByTestId('over-time').locator('.chart rect[tabindex="0"]').count()) === 30, 'the 30d range draws thirty days');
  assert((await legend.locator('li').count()) === 3, 'the same-day-last-week mark belongs to the 7d range, so 30d lists the three accounts');
  assert((await text(page.getByTestId('kpi-requests'))).includes('No earlier 30 days on record'), 'the requests tile follows the range and says when no span before it is on record');
  await page.getByTestId('usage-range-7d').click();
  assert((await page.getByTestId('over-time').locator('.chart rect[tabindex="0"]').count()) === 7, 'the 7d range draws seven days, the last one still filling');
  await page.locator('.toolbar').getByRole('button', { name: 'account2' }).click();
  await until(async () => (await legend.locator('li').count()) === 2, 'choosing account2 narrows the chart to it and keeps the same day last week');
  const narrowed = await text(legend);
  assert(narrowed.includes('account2') && narrowed.includes('Same day last week'), 'the one account left in the legend is account2, beside the same day last week');
  assert((await legendShape('account2')) === shapes[1], 'narrowing the chart to account2 keeps its shape: the filter moves neither its colour nor its marker');
  await page.getByTestId('over-time').getByRole('button', { name: 'Table' }).click();
  assert((await page.getByTestId('over-time').locator('table.data tbody tr').count()) === 7, 'the table twin holds the same seven rows as the chart');
  const cache = await text(page.getByTestId('cache'));
  assert(
    cache.includes('Cache misses by day') && cache.includes('scale 0 to 10%') && !cache.includes('served from cache') && !cache.includes('per request') && (await page.getByTestId('cache').locator('.figure').count()) === 0,
    'the cache panel is a plain chart titled for what it plots, names the 0 to 10% scale, and states no cache number of its own',
  );
  assert(/^Cache hit\s*\d+(\.\d)?%.*of input served from cache$/.test(await text(page.getByTestId('kpi-cache'))), 'the Cache hit tile holds the one cache number, as a hit rate');
  await page.getByTestId('cache').getByRole('button', { name: 'Table' }).click();
  assert(
    (await page.getByTestId('cache').locator('table.data thead th').allTextContents()).includes('Missed the cache') && (await page.getByTestId('cache').locator('table.data tbody tr').count()) === 7,
    'the cache panel keeps its table twin, one row per day with the miss share',
  );
  await page.getByTestId('cache').getByRole('button', { name: 'Chart' }).click();
  const mix = await text(page.getByTestId('mix'));
  assert(mix.includes('output tokens per request') && mix.includes('output tokens per session'), 'output per request and per session sit in What you use');
  const speed = page.getByTestId('speed');
  assert((await text(speed)).includes('How long until Claude starts answering') && (await page.getByTestId('speed').locator('.chart').count()) === 1, 'one Speed panel opens on the first token');
  assert((await speed.locator('.chart svg path[stroke-dasharray]').count()) === 1, 'the 9 in 10 line is the one dashed line, so it is not mistaken for the median');
  await speed.getByRole('button', { name: 'Finish' }).click();
  assert((await text(speed)).includes('9 in 10 finish within'), 'the Finish toggle turns the Speed panel to the whole answer, with its 9 in 10 line');
  const failuresLegend = await text(page.getByTestId('failures').getByRole('list', { name: 'Legend' }));
  assert(
    ['rate-limited', 'server error'].every((s) => failuresLegend.includes(s)) && !failuresLegend.includes('cancelled') && !/\b(429|499|5xx)\b/.test(failuresLegend),
    'the failures legend leads with plain words, names the two faults it draws and keeps the status codes out of it',
  );
  const failureFigures = page.getByTestId('failures').locator('.figures > div');
  const cancelledFigure = failureFigures.filter({ hasText: 'cancelled by you' }).locator('.figure');
  assert((await cancelledFigure.count()) === 1, 'cancelled requests stay counted in the failures figures as "cancelled by you", because they are not a fault');
  const figureColor = (figure: typeof cancelledFigure) => figure.evaluate((el) => getComputedStyle(el).color);
  assert((await figureColor(cancelledFigure)) !== (await figureColor(failureFigures.first().locator('.figure'))), 'the cancelled figure is muted, in a colour of its own against the succeeded figure');
  const failureBars = page.getByTestId('failures').locator('.chart rect[tabindex="0"]');
  let coded = false;
  for (let i = 0; i < (await failureBars.count()) && !coded; i++) {
    await failureBars.nth(i).hover();
    coded = /429 rate-limited|5xx server error|499 cancelled/.test(await text(page.locator('.tooltip')));
  }
  assert(coded, 'the failures tooltip keeps the status codes');
  const heads = await page.getByTestId('by-model').locator('thead th').allTextContents();
  assert(['Rate-limited', 'Cancelled', 'Server errors'].every((h) => heads.includes(h)) && !heads.some((h) => /^(429|499|5xx)$/.test(h)), 'the account and model table names its failure columns in words');
  assert(((await page.getByTestId('by-model').locator('thead th', { hasText: 'Rate-limited' }).getAttribute('title')) ?? '').includes('429'), 'the rate-limited header keeps the 429 code in its tooltip');
  const byModel = page.getByTestId('by-model');
  const outputs = await byModel.locator('tbody tr td:nth-child(4)').allTextContents();
  assert(outputs.length > 0 && outputs.every((o) => /^(\d{1,3}|\d{1,3}\.\d[KMB])$/.test(o.trim())), `every compact number in the table keeps one decimal above a thousand: ${outputs.join(' ')}`);
  assert((await byModel.locator('tbody tr td:first-child').allTextContents()).every((c) => !c.includes('@')), 'the account and model table names accounts by their short names');
  await page.setViewportSize({ width: 760, height: 1000 });
  assert(await byModel.locator('thead th', { hasText: 'Failed' }).isVisible(), 'below 900px the three failure columns become one Failed column');
  assert(!(await byModel.locator('thead th', { hasText: 'Rate-limited' }).isVisible()), 'below 900px the separate failure columns are gone');
  assert(
    /^\d+ rate-limited, \d+ server errors, \d+ cancelled$/.test((await byModel.locator('tbody tr').first().locator('.fail-merged [role="img"]').getAttribute('title')) ?? ''),
    'the Failed cell keeps the split in its tooltip',
  );
  assert(await byModel.locator('.table-wrap').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'at half width the account and model table fits with no clipped column');
  await page.setViewportSize({ width: 1480, height: 1000 });
  const errorLog = page.getByTestId('failures').getByTestId('errors');
  assert(/^\d+ of \d+ failures? (is|are) in CPA's log$/.test(await text(errorLog.locator('.fail-log-coverage'))), 'the log says how many of the failures it holds');
  const logLines = await errorLog.locator('.fail-lines li').allTextContents();
  assert(logLines.length > 0 && logLines.every((l) => /^\S+\s+\d{3}\s.+\saccount\d\s+last\s(today \d\d:\d\d|[A-Z][a-z]{2} \d{1,2} \d\d:\d\d)/.test(l.trim())), `each log line reads status, message, account and the time of the last one, dated like the chart axes: ${logLines.join(' | ')}`);
  assert(logLines.every((l) => !/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d\b/.test(l)), 'no time in the log reads as a weekday, which looks a week old the day after');
  assert(logLines.every((l) => !l.includes('@') && !l.includes('—')), 'the log names accounts by their short names and shows no empty placeholder');
  assert(logLines.some((l) => /×\d+/.test(l)), 'identical errors on one account are one line with a count');
  assert((await page.getByTestId('analytics').getByText('Recent errors and rate limits', { exact: true }).count()) === 0, 'the error log is a section of Failures and no longer a panel of its own');
  await page.getByTestId('analytics').screenshot({ path: join(SHOTS, 'e2e-4b-usage.png') });
  await page.getByTestId('nav-monitor').click();
  await card('account1@example.com').waitFor();
  pass('Usage opens from its tab, answers the week, pace and pattern questions, narrows by account, and Monitor comes back');

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
