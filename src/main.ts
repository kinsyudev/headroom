import { join } from 'node:path';
import { createAnthropic, realClock } from './server/anthropic';
import { createClaims } from './server/claims';
import { loadConfig, readManagementKey } from './server/config';
import { createCpa } from './server/cpa';
import { handlers } from './server/handlers';
import { buildUi, serve } from './server/http';
import { openKeeper } from './server/keeper';
import { createOAuthFlows } from './server/oauth';
import { createObserver } from './server/observer';
import { createPoller } from './server/poller';
import { openStateFile } from './server/state';
import type { Snapshot } from './shared/domain';

const config = loadConfig();
const clock = realClock;
const state = openStateFile(join(config.stateDir, 'state.json'));
const cpa = createCpa({ baseUrl: config.cpaBaseUrl, envPath: config.envPath, readKey: () => readManagementKey(config.envPath), state, now: clock.now });
const anthropic = createAnthropic({ cpa, cliVersion: config.claudeCliVersion, clock, state });
const observer = createObserver({ cpa, now: clock.now });
const poller = createPoller({ anthropic, accounts: observer.accounts, linkOk: () => cpa.link().kind === 'ok', clock, state });
const keeper = openKeeper(config.keeperDbPath, clock.now);
const claims = createClaims({ anthropic, cpa, poller, clock, state });
const oauth = createOAuthFlows({ cpa, observer, now: clock.now });

const snapshot = (): Snapshot => ({
  generatedAt: clock.now(),
  cpaBaseUrl: config.cpaBaseUrl,
  link: cpa.link(),
  cpa: observer.cpa(),
  strategy: observer.strategy(),
  feeds: poller.feeds(),
  serving: keeper.serving(),
  claims: claims.list(),
  flows: oauth.list(),
});

const server = serve({
  hostname: config.hostname,
  port: config.port,
  assets: await buildUi(join(import.meta.dir, 'ui/index.html')),
  snapshot,
  usage: () => keeper.usage(observer.accounts().map((a) => a.id)),
  handlers,
  ctx: { cpa, observer, poller, claims, oauth },
});

startAfterBind(server, [observer, keeper, poller]);
console.log(`Headroom on ${server.url} (CPA ${config.cpaBaseUrl}, claude-cli/${config.claudeCliVersion}, link ${cpa.link().kind})`);

function startAfterBind(_bound: ReturnType<typeof serve>, loops: readonly { start(): void }[]): void {
  for (const loop of loops) loop.start();
}

async function shutdown(): Promise<void> {
  poller.stop();
  observer.stop();
  keeper.stop();
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
