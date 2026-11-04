/**
 * Page layout. It's the only component that sees Snapshot. It derives the DeckView and hands slices down.
 *
 *   <Banners />                  link down, CPA unreachable, claim in doubt, SSE lost
 *   <OverviewStrip />            serving · headroom · next reset · claimable · strategy toggle · add account
 *   <section grid>               <AccountCard /> × N
 *   <HistoryPanel />             fetches its own data (useHistory); not part of the snapshot
 *   <AddAccountDialog />         when a flow is waiting or just finished
 */
import { useSnapshot } from './api';
import { useDeck } from './deck';
import { AccountCard } from './components/AccountCard';
import { AddAccountDialog } from './components/AddAccountDialog';
import { Banners } from './components/Banners';
import { HistoryPanel } from './components/HistoryPanel';
import { OverviewStrip } from './components/OverviewStrip';

export function App() {
  // TODO:
  // const { snapshot, connection } = useSnapshot();
  // const deck = useDeck(snapshot);
  // if (!deck) return <Splash connection={connection} />;
  // const emails = new Map(deck.accounts.map(a => [a.id, a.email]))   // HistoryPanel labels series by email
  // render the layout above
  void [useSnapshot, useDeck, AccountCard, AddAccountDialog, Banners, HistoryPanel, OverviewStrip];
  throw new Error('not implemented');
}
