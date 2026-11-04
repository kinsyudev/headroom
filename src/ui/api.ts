import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ActionInput, ActionKind, ActionOutput } from '../shared/actions';
import { DeckError, type DeckErrorCode } from '../shared/errors';
import type { Snapshot } from '../shared/domain';
import type { HistoryRange, HistoryView } from '../shared/history';

export const SNAPSHOT_POLL_MS = 2_000;
const HISTORY_POLL_MS = 60_000;

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
    headers: { 'Content-Type': 'application/json', 'X-CPA-Deck': '1' },
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

export function useHistory(range: HistoryRange): { history: HistoryView | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ history: HistoryView | null; loading: boolean; error: string | null }>({ history: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const res = await fetch(`/api/history?range=${range}`, { cache: 'no-store' });
        const body = (await res.json()) as HistoryView & { error?: { message?: string } };
        if (!res.ok) throw new Error(body.error?.message ?? `history ${res.status}`);
        if (alive) setState({ history: body, loading: false, error: null });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        if (alive) timer = setTimeout(() => void load(), HISTORY_POLL_MS);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [range]);
  return state;
}
