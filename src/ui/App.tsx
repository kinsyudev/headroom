import { useState } from 'react';
import type { AccountId, GrantId, ProgramId } from '../shared/domain';
import { RefreshContext, useSnapshotPoll, type Connection } from './api';
import { AccountCard } from './components/AccountCard';
import { Banners } from './components/Banners';
import { ClaimDialog } from './components/ClaimDialog';
import { Header } from './components/Header';
import { HistoryPanel } from './components/HistoryPanel';
import { OverviewStrip } from './components/OverviewStrip';
import { CpaProvider, useDeck } from './deck';

const IDENTITY_HUES = 6;

interface ClaimTarget {
  readonly account: AccountId;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
}

export function App() {
  const { snapshot, connection, refresh } = useSnapshotPoll();
  const deck = useDeck(snapshot);
  const [claim, setClaim] = useState<ClaimTarget | null>(null);
  if (!deck) return <Splash connection={connection} />;

  const colors = new Map(deck.accounts.map((a, i) => [a.id, `var(--id-${(i % IDENTITY_HUES) + 1})`]));
  const claimAccount = claim ? deck.accounts.find((a) => a.id === claim.account) : undefined;

  return (
    <RefreshContext.Provider value={refresh}>
      <CpaProvider value={deck.cpa}>
        <div className={deck.cpa.kind === 'down' ? 'page cpa-down' : 'page'}>
          <Header deck={deck} connection={connection} />
          <Banners banners={deck.banners} connection={connection} />
          <OverviewStrip deck={deck} colors={colors} onClaim={(account, program, grant) => setClaim({ account, program, grant })} />
          <section className="cards" aria-label="Accounts">
            {deck.accounts.length === 0 && <p className="muted">No Claude accounts in CPA yet.</p>}
            {deck.accounts.map((a) => (
              <AccountCard key={a.id} account={a} color={colors.get(a.id)!} onClaim={(program, grant) => setClaim({ account: a.id, program, grant })} />
            ))}
          </section>
          <HistoryPanel accounts={deck.accounts.map((a) => ({ id: a.id, email: a.email, color: colors.get(a.id)! }))} />
        </div>
        {claim && claimAccount && <ClaimDialog account={claimAccount} program={claim.program} grant={claim.grant} onClose={() => setClaim(null)} />}
      </CpaProvider>
    </RefreshContext.Provider>
  );
}

function Splash(props: { readonly connection: Connection }) {
  return (
    <div className="splash">
      <h1>Headroom</h1>
      <p className="muted">{props.connection === 'lost' ? 'Cannot reach the Headroom server. Retrying every 2 s.' : 'Connecting…'}</p>
    </div>
  );
}
