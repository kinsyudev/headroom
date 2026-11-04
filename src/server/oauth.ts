/**
 * Add-account OAuth flows. This module is the only writer of `Snapshot.flows`, which live in memory only.
 *
 * The server polls CPA for the flow status, not the browser. The management key stays server-side,
 * and the flow still completes if the operator closes the deck tab while signing in.
 *
 * Only one flow waits at a time, because CPA's callback forwarder on :54545 serves one flow.
 * Starting a new flow cancels the waiting one.
 */
import type { FlowId, Instant, OAuthFlow } from '../shared/domain';
import type { Cpa } from './cpa';
import type { Observer } from './observer';

export const FLOW_POLL_MS = 2_000;
export const FLOW_TTL_MS = 5 * 60_000; // CPA's waiter gives up after 5 minutes
export const FLOW_KEEP_MS = 10 * 60_000; // finished flows stay visible this long

export interface OAuthFlows {
  /**
   * TODO:
   * cancel any waiting flow
   * { url, state } = await cpa.startOAuth()          (GET /anthropic-auth-url?is_webui=true)
   * known = set of current AccountIds (observer.state().cpa)
   * flow = { id: randomUUID, url, startedAt: now, status: 'waiting' }; private: state, known
   * poll loop every FLOW_POLL_MS: cpa.oauthStatus(state)
   *   'ok'    → status ok; await observer.refreshCpa(); account = first id not in `known`
   *   'error' → status error, error text
   *   now - startedAt > FLOW_TTL_MS → expired
   *   link down → stop polling, status error 'management link down'
   * return { flow: id, url }. The UI opens `url` in the tab it pre-opened during the click.
   */
  start(): Promise<{ flow: FlowId; url: string }>;
  cancel(flow: FlowId): void;
  list(): readonly OAuthFlow[];
  onChange(cb: () => void): () => void;
}

export function createOAuthFlows(deps: { readonly cpa: Cpa; readonly observer: Observer; readonly now: () => Instant }): OAuthFlows {
  throw new Error('not implemented');
}

