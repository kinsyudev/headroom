import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ActionInput, ActionKind, ActionOutput } from '../shared/actions';
import { DeckError, type DeckErrorCode } from '../shared/errors';
import type { Snapshot } from '../shared/domain';
import { deriveAnalytics, type UsageCube } from '../shared/usage';
import type { AccountView, AnalyticsLens, AnalyticsView } from '../shared/view';

export const SNAPSHOT_POLL_MS = 2_000;
const USAGE_POLL_MS = 60_000;
/** While the server is still reading the history at startup, the page asks again this soon. */
const USAGE_CATCHING_UP_POLL_MS = 2_000;

export type Connection = 'connecting' | 'live' | 'lost';

export const RefreshContext = createContext<() => void>(() => undefined);

export function useSnapshotPoll(): { snapshot: Snapshot | null; connection: Connection; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  const again = useRef(false);

  const poll = useCallback(async (): Promise<void> => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    clearTimeout(timer.current);
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      setSnapshot((await res.json()) as Snapshot);
      setConnection('live');
    } catch {
      setConnection('lost');
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void poll();
      } else {
        timer.current = setTimeout(() => void poll(), SNAPSHOT_POLL_MS);
      }
    }
  }, []);

  useEffect(() => {
    void poll();
    return () => clearTimeout(timer.current);
  }, [poll]);

  return { snapshot, connection, refresh: () => void poll() };
}

export async function act<K extends ActionKind>(kind: K, input: ActionInput<K>): Promise<ActionOutput<K>> {
  const res = await fetch('/api/act', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Headroom': '1' },
    body: JSON.stringify({ kind, input }),
  });
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new DeckError((body?.error?.code ?? 'invalid') as DeckErrorCode, body?.error?.message ?? `HTTP ${res.status}`);
  return body as ActionOutput<K>;
}

export type ActionStatus =
  | { readonly phase: 'idle' }
  | { readonly phase: 'pending' }
  | { readonly phase: 'ok'; readonly at: number }
  | { readonly phase: 'error'; readonly code: string; readonly message: string; readonly at: number };

export function useAction<K extends ActionKind>(kind: K) {
  const refresh = useContext(RefreshContext);
  const [status, setStatus] = useState<ActionStatus>({ phase: 'idle' });
  const busy = useRef(false);
  const run = useCallback(
    async (input: ActionInput<K>): Promise<ActionOutput<K> | undefined> => {
      if (busy.current) return undefined;
      busy.current = true;
      setStatus({ phase: 'pending' });
      try {
        const out = await act(kind, input);
        setStatus({ phase: 'ok', at: Date.now() });
        return out;
      } catch (e) {
        setStatus({ phase: 'error', code: e instanceof DeckError ? e.code : 'network', message: e instanceof Error ? e.message : String(e), at: Date.now() });
        return undefined;
      } finally {
        busy.current = false;
        refresh();
      }
    },
    [kind, refresh],
  );
  return { run, status, pending: status.phase === 'pending', reset: useCallback(() => setStatus({ phase: 'idle' }), []) };
}

export type AnalyticsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: string }
  /** refreshing: a newer history is on its way. error: the last refresh failed, and the view is the last good one. */
  | { readonly kind: 'ready'; readonly view: AnalyticsView; readonly refreshing: boolean; readonly error: string | null };

/**
 * Every analytics component reads usage through this. However many call it, the page polls /api/usage once, every
 * 60 s, or every 2 s while the server is catching up. Changing the lens refolds in memory with no request.
 * `accounts` is deck.accounts: emails, the account order and the quota windows pace reads.
 */
export function useAnalytics(lens: AnalyticsLens, accounts: readonly AccountView[]): AnalyticsState {
  const s = useSyncExternalStore(usage.listen, usage.get);
  const { range, grain, account, model } = lens;
  // The lens is compared by its fields, so a caller's fresh object with the same lens refolds nothing.
  return useMemo((): AnalyticsState => {
    if (!s.cube) return s.error === null ? { kind: 'loading' } : { kind: 'failed', error: s.error };
    return { kind: 'ready', view: deriveAnalytics(s.cube, lens, accounts), refreshing: s.loading, error: s.error };
  }, [s, range, grain, account, model, accounts]);
}

interface UsageState {
  readonly cube: UsageCube | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** The one poller of /api/usage. It runs while at least one component listens. */
const usage = (() => {
  let state: UsageState = { cube: null, loading: true, error: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const set = (next: UsageState) => {
    state = next;
    for (const l of listeners) l();
  };
  const load = async () => {
    running = true;
    set({ ...state, loading: true });
    let next = USAGE_POLL_MS;
    try {
      const res = await fetch('/api/usage', { cache: 'no-store' });
      const body = (await res.json()) as UsageCube & { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `usage ${res.status}`);
      set({ cube: body, loading: false, error: null });
      if (body.catchingUp) next = USAGE_CATCHING_UP_POLL_MS;
    } catch (e) {
      set({ ...state, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
    running = false;
    if (listeners.size > 0) timer = setTimeout(() => void load(), next);
  };
  return {
    listen(onChange: () => void): () => void {
      listeners.add(onChange);
      if (!running && timer === undefined) void load();
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    get: () => state,
  };
})();
