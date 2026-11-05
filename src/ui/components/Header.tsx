/**
 * Add account: a popup blocker only allows window.open inside the click, and the URL arrives
 * after an await, so the tab is opened blank first and pointed at the URL once it is known.
 */
import { useState } from 'react';
import type { RoutingStrategy } from '../../shared/domain';
import type { DeckView } from '../../shared/view';
import { useAction, type Connection } from '../api';
import { Mark, Wordmark } from '../brand';
import { usePaused } from '../deck';
import { clockTime, duration } from '../format';
import { VIEWS, type ViewKey } from '../route';
import { ActionButton } from './ActionButton';
import { Countdown } from './Countdown';
import { Status } from './Freshness';
import { Segments } from './Segments';

const STRATEGIES: readonly RoutingStrategy[] = ['fill-first', 'round-robin'];
const STRATEGY: Readonly<Record<RoutingStrategy, { readonly gloss: string; readonly help: string }>> = {
  'fill-first': { gloss: 'one account until full', help: 'fill-first: use one account until it is full. New sessions go to the highest-priority account until it is limited' },
  'round-robin': { gloss: 'rotate accounts', help: 'round-robin: rotate. New sessions take turns across the available accounts' },
};
const FLOW_TTL_MS = 5 * 60_000;

export function Header(props: { readonly deck: DeckView; readonly connection: Connection; readonly view: ViewKey }) {
  const d = props.deck;
  const runningOut = d.overview.runningOut;
  const cpaDown = props.connection === 'live' && d.cpa.kind === 'down';
  const status = cpaDown ? 'cpa-down' : props.connection;
  return (
    <header className="topbar">
      <div className="brand">
        <Mark size={24} />
        <Wordmark />
      </div>
      <nav className="views" aria-label="Views">
        {VIEWS.map((v) => (
          <a key={v.key} href={v.hash} className="view-tab" aria-current={v.key === props.view ? 'page' : undefined} data-testid={v.testId}>
            {v.label}
            {v.key === 'usage' && runningOut.length > 0 && (
              <span
                className="tab-badge"
                title={runningOut
                  .map((r) => `${r.email.split('@')[0]} ${r.limit.label.toLowerCase()} runs out ~${clockTime(r.at, d.now)}, ${duration(r.resetsAt - r.at)} before it resets`)
                  .join('\n')}
              >
                {runningOut.length} {runningOut.length === 1 ? 'runs' : 'run'} out
              </span>
            )}
          </a>
        ))}
      </nav>
      <div className="topbar-controls" hidden={props.view !== 'monitor'}>
        <div className="segmented" role="group" aria-label="Routing strategy" data-testid="strategy">
          <span className="segmented-label">Routing</span>
          {STRATEGIES.map((s) => (
            <ActionButton
              key={s}
              kind="routing.setStrategy"
              input={{ strategy: s }}
              disabled={d.strategy === s}
              variant={d.strategy === s ? 'selected' : 'quiet'}
              title={STRATEGY[s].help}
              done="switched"
              testId={`strategy-${s}`}
            >
              {s}
            </ActionButton>
          ))}
          {d.strategy && <span className="segmented-gloss">{STRATEGY[d.strategy].gloss}</span>}
        </div>
        <ActionButton
          kind="quota.refresh"
          input={{ account: 'all' }}
          done={(o) => `${o.scheduled.filter((x) => x.held === null).length} of ${o.scheduled.length} queued`}
          title="Check Anthropic usage for every account that isn't rate-limited or checked in the last minute"
          testId="refresh-all"
        >
          ↻ Check all
        </ActionButton>
        <AddAccount deck={d} />
      </div>
      <div className="topbar-status">
        <span
          className={`live-dot ${status}`}
          title={cpaDown ? 'The Headroom server is live; CPA is not answering' : `snapshot ${props.connection}`}
          aria-label={cpaDown ? 'CPA down' : `connection ${props.connection}`}
        />
        <Status status={d.status} />
      </div>
    </header>
  );
}

function AddAccount(props: { readonly deck: DeckView }) {
  const start = useAction('oauth.start');
  const cancel = useAction('oauth.cancel');
  const paused = usePaused();
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const flow = props.deck.flows[0];
  const recent = flow && (flow.status === 'waiting' || props.deck.now - flow.startedAt < 2 * FLOW_TTL_MS) ? flow : null;
  const added = recent?.account ? props.deck.accounts.find((a) => a.id === recent.account)?.email : null;
  return (
    <div className="add-account">
      <button
        type="button"
        className="btn quiet"
        disabled={start.pending || paused !== null}
        title={paused ?? undefined}
        data-testid="add-account"
        onClick={async () => {
          const tab = window.open('about:blank', '_blank');
          const out = await start.run({});
          if (!out) return tab?.close();
          if (tab) tab.location.href = out.url;
          else setBlockedUrl(out.url);
        }}
      >
        {start.pending ? 'Starting…' : '+ Add account'}
      </button>
      {start.status.phase === 'error' && <span className="feedback error">✕ {start.status.message}</span>}
      {recent && (
        <span className="flow" data-testid="oauth-flow" data-status={recent.status}>
          {recent.status === 'waiting' && (
            <>
              <span className="spinner" aria-hidden />{' '}
              <Segments parts={['Finish signing in in the other tab', <>expires in <Countdown at={recent.startedAt + FLOW_TTL_MS} /></>]} />{' '}
              {blockedUrl && (
                <a href={blockedUrl} target="_blank" rel="noreferrer">
                  open sign-in
                </a>
              )}{' '}
              <button type="button" className="btn quiet small" disabled={cancel.pending} onClick={() => void cancel.run({ flow: recent.id })}>
                Cancel
              </button>
            </>
          )}
          {recent.status === 'ok' && <span className="feedback ok">✓ Added {added ?? 'the account'}</span>}
          {recent.status === 'error' && <span className="feedback error">✕ {recent.error}</span>}
          {recent.status === 'expired' && <span className="feedback error">✕ Timed out after 5 minutes</span>}
          {recent.status === 'cancelled' && <span className="muted">Cancelled</span>}
        </span>
      )}
    </div>
  );
}
