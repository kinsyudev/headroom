/**
 * Composition root. One long-lived process, kept alive by launchd (launchd/com.kinsyu.cpa-deck.plist).
 *
 * The process never exits on a bad or missing management key. Exiting would make launchd restart
 * it, and each restart would spend one CPA auth attempt. It stays up instead, shows the link banner,
 * and waits for the env file to change.
 *
 * Order matters:
 *   0. Construct every module. Constructors do no network I/O.
 *   1. serve(). Binding the port is the single-instance lock, so a second copy dies here before
 *      touching CPA. Until step 5, POST /api/act answers 503 link_down.
 *   2. cpa.validate(): one GET /auth-files, or none if the persisted auth-failure budget is spent.
 *   3. observer.start(): loads persisted poll slots, so a restart resumes the schedule.
 *   4. claims.recover(): sending → in_doubt, resume followups.
 *   5. server.acceptActions().
 */
import app from './ui/index.html';
import { loadConfig, readManagementKey, watchManagementKey } from './server/config';
import { createCpa } from './server/cpa';
import { createAnthropic } from './server/anthropic';
import { createObserver } from './server/observer';
import { createClaims } from './server/claims';
import { createOAuthFlows } from './server/oauth';
import { openKeeper } from './server/keeper';
import { handlers } from './server/handlers';
import { serve } from './server/http';
import type { Instant } from './shared/domain';

async function main(): Promise<void> {
  // TODO:
  // const now = () => Date.now() as Instant
  // const config = loadConfig()
  // const store = openStore(config.deckDbPath)
  // const cpa = createCpa({ baseUrl: config.cpaBaseUrl, key: readManagementKey(config.envPath), envPath, authFailures: store.authFailures, now })
  // const anthropic = createAnthropic({ cpa, cliVersion: config.claudeCliVersion, now })
  // const observer = createObserver({ cpa, anthropic, slots: store.pollSlots, now })
  // const claims = createClaims({ table: store.claims, anthropic, cpa, observer, now })
  // const oauth = createOAuthFlows({ cpa, observer, now })
  // const keeper = openKeeper(config.keeperDbPath, { timeZone: config.timeZone })
  // const server = serve({ port: config.port, app, cpa, observer, claims, oauth, keeper, handlers, now })   // 1
  // await cpa.validate()
  // observer.onPrograms((id, p) => claims.reconcile(id, p))
  // observer.start()
  // await claims.recover()
  // server.acceptActions()                                                                                 // 5
  // watchManagementKey(config.envPath, (k) => void cpa.setKey(k))
  // SIGTERM → observer.stop(); server.stop(); store.close()
  void [app, loadConfig, readManagementKey, watchManagementKey, createCpa, createAnthropic, createObserver, createClaims, createOAuthFlows, openKeeper, handlers, serve];
  void (0 as unknown as Instant);
  throw new Error('not implemented');
}

void main();
