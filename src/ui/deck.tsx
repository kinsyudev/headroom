/**
 * The clock and the derived deck.
 *
 * One 1 Hz clock for the whole app (ClockProvider), not one interval per countdown.
 * useDeck() runs deriveDeck(snapshot, now) once per tick at the App level and passes AccountView
 * and OverviewView down as props. Components below App don't call useDeck or touch Snapshot.
 */
import type { ReactNode } from 'react';
import { deriveDeck } from '../shared/derive';
import type { Instant, Snapshot } from '../shared/domain';
import type { DeckView } from '../shared/view';

export function ClockProvider(props: { children: ReactNode }): ReactNode {
  // TODO: context with Date.now() as Instant, updated every 1000 ms aligned to the second boundary
  //       so every countdown on screen ticks together.
  throw new Error('not implemented');
}

export function useNow(): Instant {
  throw new Error('not implemented');
}

/** null until the first snapshot arrives. */
export function useDeck(snapshot: Snapshot | null): DeckView | null {
  // TODO: const now = useNow(); return useMemo(() => snapshot && deriveDeck(snapshot, now), [snapshot, now])
  void deriveDeck;
  throw new Error('not implemented');
}
