/**
 * Add-account OAuth flows, in memory. The server polls CPA for the result, not the browser, so
 * the key stays server-side and the flow still completes if the deck tab closes. CPA's callback
 * forwarder serves one flow at a time, so starting a new flow cancels the waiting one.
 */
import { DeckError } from '../shared/errors';
import type { AccountId, FlowId, Instant, OAuthFlow } from '../shared/domain';
import type { Cpa } from './cpa';
import type { Observer } from './observer';

export const FLOW_POLL_MS = 2_000;
export const FLOW_TTL_MS = 5 * 60_000;
export const FLOW_KEEP_MS = 10 * 60_000;

export interface OAuthFlows {
  start(): Promise<{ flow: FlowId; url: string }>;
  cancel(flow: FlowId): void;
  list(): readonly OAuthFlow[];
}

export function createOAuthFlows(deps: { readonly cpa: Cpa; readonly observer: Observer; readonly now: () => Instant; readonly pollMs?: number }): OAuthFlows {
  let flows: OAuthFlow[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  function set(id: FlowId, patch: Partial<OAuthFlow>): void {
    flows = flows.map((f) => (f.id === id ? { ...f, ...patch } : f));
  }

  function stopPolling(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    async start() {
      for (const f of flows) if (f.status === 'waiting') set(f.id, { status: 'cancelled' });
      stopPolling();
      const { url, state } = await deps.cpa.startOAuth();
      const known = new Set(deps.observer.accounts().map((a) => a.id));
      const flow: OAuthFlow = { id: crypto.randomUUID() as FlowId, url, startedAt: deps.now(), status: 'waiting', error: null, account: null };
      flows = [flow, ...flows.filter((f) => deps.now() - f.startedAt < FLOW_KEEP_MS)];
      let busy = false;
      timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          if (deps.now() - flow.startedAt > FLOW_TTL_MS) {
            set(flow.id, { status: 'expired' });
            return stopPolling();
          }
          const s = await deps.cpa.oauthStatus(state);
          if (s.kind === 'ok') {
            stopPolling();
            await deps.observer.refresh();
            const added = deps.observer.accounts().find((a) => !known.has(a.id));
            set(flow.id, { status: 'ok', account: (added?.id ?? null) as AccountId | null });
          } else if (s.kind === 'error') {
            stopPolling();
            set(flow.id, { status: 'error', error: s.error });
          }
        } catch (e) {
          if (e instanceof DeckError && e.code === 'link_down') {
            stopPolling();
            set(flow.id, { status: 'error', error: 'management link down' });
          }
        } finally {
          busy = false;
        }
      }, deps.pollMs ?? FLOW_POLL_MS);
      return { flow: flow.id, url };
    },
    cancel(id) {
      const f = flows.find((x) => x.id === id);
      if (f?.status !== 'waiting') return;
      stopPolling();
      set(id, { status: 'cancelled' });
    },
    list: () => flows,
  };
}
