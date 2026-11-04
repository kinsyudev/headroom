import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { deriveDeck } from '../shared/derive';
import type { Instant, Snapshot } from '../shared/domain';
import type { DeckView } from '../shared/view';

const ClockContext = createContext<Instant>(Date.now() as Instant);

export function ClockProvider(props: { readonly children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now() as Instant);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now() as Instant);
      timer = setTimeout(tick, 1_005 - (Date.now() % 1_000));
    };
    timer = setTimeout(tick, 1_005 - (Date.now() % 1_000));
    return () => clearTimeout(timer);
  }, []);
  return <ClockContext.Provider value={now}>{props.children}</ClockContext.Provider>;
}

export function useNow(): Instant {
  return useContext(ClockContext);
}

export function useDeck(snapshot: Snapshot | null): DeckView | null {
  const now = useNow();
  return useMemo(() => (snapshot ? deriveDeck(snapshot, now) : null), [snapshot, now]);
}
