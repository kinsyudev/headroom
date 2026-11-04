/**
 * The UI's only I/O. Components never call fetch.
 *
 * - useSnapshot(): subscribes to /api/stream (EventSource reconnects on its own) and returns the
 *   latest Snapshot. It's the only source of live state.
 * - act(kind, input): the only way to mutate. Typed by the action table, so
 *   `act('account.makePrimary', { account })` returns `Promise<Applied & { priority; changed }>`.
 * - useAction(kind): wraps act() with pending and error state for a button. `pending` disables the
 *   button, which is the UI half of double-click safety. The server half is idempotency.
 * - useHistory(range): GET /api/history on mount and every 60 s.
 */
import type { ActionInput, ActionKind, ActionOutput } from '../shared/actions';
import { DeckError } from '../shared/actions';
import type { Snapshot } from '../shared/domain';
import type { HistoryRange, HistoryView } from '../shared/history';

export type Connection = 'connecting' | 'live' | 'lost';

export function useSnapshot(): { readonly snapshot: Snapshot | null; readonly connection: Connection } {
  // TODO: EventSource('/api/stream'); on 'snapshot' → JSON.parse → setState (drop if version <= current);
  //       onerror → 'lost' (keep last snapshot; the derived freshness ages keep counting up, which is correct)
  throw new Error('not implemented');
}

/**
 * TODO:
 * csrf = cached GET /api/session token (fetched once; refetched once on 403, since a server restart rotates it)
 * res = fetch('/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deck-Csrf': csrf },
 *                           body: JSON.stringify({ kind, input }) })
 * !res.ok → body.error → throw new DeckError(code, message)
 * return res.json()
 */
export async function act<K extends ActionKind>(kind: K, input: ActionInput<K>): Promise<ActionOutput<K>> {
  void DeckError;
  throw new Error('not implemented');
}

export function useAction<K extends ActionKind>(
  kind: K,
): {
  readonly run: (input: ActionInput<K>) => Promise<ActionOutput<K> | undefined>;
  readonly pending: boolean;
  readonly error: DeckError | null;
} {
  // TODO: single-flight: run() while pending returns undefined without calling act().
  throw new Error('not implemented');
}

export function useHistory(range: HistoryRange): { readonly history: HistoryView | null; readonly error: string | null } {
  throw new Error('not implemented');
}
