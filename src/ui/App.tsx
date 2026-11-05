import { useState } from 'react';
import type { AccountId, GrantId, ProgramId } from '../shared/domain';
import { RefreshContext, useSnapshotPoll, type Connection } from './api';
import { Mark, Wordmark } from './brand';
import { Accounts } from './components/Accounts';
import { Banners } from './components/Banners';
import { ClaimDialog } from './components/ClaimDialog';
import { Header } from './components/Header';
import { HistoryPanel } from './components/HistoryPanel';
import { OverviewStrip } from './components/OverviewStrip';
import { Usage } from './components/usage/Usage';
import { CpaProvider, useDeck } from './deck';
import { useView } from './route';

const IDENTITY_HUES = 5;

interface ClaimTarget {
  readonly account: AccountId;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
}

export function App() {
  const { snapshot, connection, refresh } = useSnapshotPoll();
  const deck = useDeck(snapshot);
  const [claim, setClaim] = useState<ClaimTarget | null>(null);
  const view = useView();
  if (!deck) return <Splash connection={connection} />;

  const colors = new Map(deck.accounts.map((a, i) => [a.id, `var(--id-${(i % IDENTITY_HUES) + 1})`]));
  const claimAccount = claim ? deck.accounts.find((a) => a.id === claim.account) : undefined;

  return (
    <RefreshContext.Provider value={refresh}>
      <CpaProvider value={deck.cpa}>
        <div className={deck.cpa.kind === 'down' ? 'page cpa-down' : 'page'}>
          <Header deck={deck} connection={connection} view={view} />
          <Banners banners={deck.banners} connection={connection} />
          {view === 'monitor' ? (
            <>
              <OverviewStrip deck={deck} colors={colors} />
              <Accounts
                accounts={deck.accounts}
                columns={deck.limitColumns}
                extraUsage={deck.extraUsageColumn}
                claimable={deck.overview.claimable}
                colors={colors}
                onClaim={(account, program, grant) => setClaim({ account, program, grant })}
              />
              <HistoryPanel accounts={deck.accounts} colors={colors} />
            </>
          ) : (
            <Usage accounts={deck.accounts} colors={colors} />
          )}
        </div>
        {claim && claimAccount && <ClaimDialog account={claimAccount} program={claim.program} grant={claim.grant} onClose={() => setClaim(null)} />}
      </CpaProvider>
    </RefreshContext.Provider>
  );
}

function Splash(props: { readonly connection: Connection }) {
  return (
    <div className="splash">
      <Mark size={56} />
      <Wordmark />
      <p className="muted">{props.connection === 'lost' ? 'Cannot reach the Headroom server. Retrying every 2 s.' : 'Connecting…'}</p>
    </div>
  );
}
