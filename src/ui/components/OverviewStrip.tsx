import { Fragment } from 'react';
import type { AccountId, Instant } from '../../shared/domain';
import type { DeckView, ServeLine } from '../../shared/view';
import { leftLabel, percent, reasonTitle } from '../format';
import { Age, Clock, Countdown } from './Countdown';
import { resetsAnchor } from './ResetOffers';
import { Segments } from './Segments';

const ORDER_HELP = {
  ranked: 'Where CPA sends a new session: fill-first tries the highest priority first, so 1 takes the next new session. Blocked and disabled accounts take nothing until they are back.',
  rotates: 'Round-robin takes turns through the accounts in line. Blocked and disabled accounts take nothing until they are back.',
};

export function OverviewStrip(props: { readonly deck: DeckView; readonly colors: ReadonlyMap<AccountId, string> }) {
  const o = props.deck.overview;
  const { cpa } = props.deck;
  const down = cpa.kind === 'down';
  const swatch = (id: AccountId) => <span className="swatch small" style={{ background: props.colors.get(id) }} aria-hidden />;
  const who = (id: AccountId, email: string) => (
    <span className="nowrap" title={email}>
      {swatch(id)} {email.split('@')[0]}
    </span>
  );
  const lead = o.serving[0];
  const hero = (a: { readonly account: AccountId; readonly email: string } | null | undefined) =>
    a ? (
      <p className="hero hero-id" title={a.email}>
        {swatch(a.account)}
        <span className="hero-text">{a.email}</span>
      </p>
    ) : (
      <p className="hero muted">Idle</p>
    );
  const when = (at: Instant) =>
    down ? (
      <>
        at <Clock at={at} />
      </>
    ) : (
      <>
        <Age at={at} /> ago
      </>
    );
  const inLine = o.order.lines.filter((l) => l.kind === 'in_line');
  const claimAccounts = o.claimable;
  return (
    <section className="summary" aria-label="Overview" data-testid="overview">
      {cpa.kind === 'down' && (
        <p className="summary-asof">
          {cpa.lastAt === null ? (
            'CPA has not answered yet'
          ) : (
            <Segments
              parts={[
                'Last known values',
                <>
                  CPA last answered <Clock at={cpa.lastAt} />
                </>,
              ]}
            />
          )}
        </p>
      )}

      <div
        className="stat serving"
        data-testid="tile-serving"
        title={`Evidence: ${o.servingEvidence === 'keeper' ? 'the request log behind History' : 'CPA response headers (the request log is unavailable)'}`}
      >
        <h2>Serving now</h2>
        {o.order.rotates ? (
          <>
            <p className="serving-label" data-testid="serving-latest">
              Latest request{lead ? <> · {when(lead.lastAt)}</> : ', none in the last 2 min'}
            </p>
            {hero(lead)}
            <p className="stat-sub" data-testid="serving-new">
              <span className="serving-key">New sessions</span>{' '}
              {inLine.length === 0 ? (
                <span className="badge critical">No account can take traffic</span>
              ) : (
                <>
                  take turns across{' '}
                  {inLine.map((l, i) => (
                    <Fragment key={l.account}>
                      {i > 0 && ', '}
                      {who(l.account, l.email)}
                    </Fragment>
                  ))}
                </>
              )}
            </p>
          </>
        ) : (
          <>
            <p className="serving-label" data-testid="serving-new">
              New sessions go to
            </p>
            {o.target ? (
              hero(o.target)
            ) : (
              <p className="hero">
                <span className="badge critical">No account can take traffic</span>
              </p>
            )}
            <p className="stat-sub" data-testid="serving-latest">
              <span className="serving-key">Latest request</span>{' '}
              {lead ? (
                <>
                  {who(lead.account, lead.email)} · {when(lead.lastAt)}
                </>
              ) : (
                'none in the last 2 min'
              )}
            </p>
          </>
        )}
      </div>

      <div className="stat" data-testid="tile-next-reset">
        <h2>Next reset</h2>
        {o.nextReset ? (
          <>
            <p className="hero num">
              <Countdown at={o.nextReset.at} />
            </p>
            <p className="stat-sub">
              <Segments
                parts={[
                  who(o.nextReset.account, o.nextReset.email),
                  <>
                    {o.nextReset.label.toLowerCase()} resets <Clock at={o.nextReset.at} />
                  </>,
                ]}
              />
            </p>
          </>
        ) : (
          <>
            <p className="hero muted">—</p>
            <p className="stat-sub">No window with a known reset</p>
          </>
        )}
      </div>

      <div className={o.claimableCount > 0 && !down ? 'stat claims has-claims' : 'stat claims'} data-testid="tile-claimable">
        <h2>Claimable resets</h2>
        <p className="hero num">{o.claimableCount}</p>
        <p className="stat-sub">
          {down ? (
            'Claims are paused until CPA answers.'
          ) : claimAccounts.length === 0 ? (
            'None now. Offered when an account hits its limit.'
          ) : (
            <Segments
              parts={claimAccounts.map((g) => (
                <a className="jump" href={`#${resetsAnchor(g.account)}`}>
                  {g.resets.length === 1 ? 'Review' : `Review ${g.resets.length}`} on {who(g.account, g.email)} ↓
                </a>
              ))}
            />
          )}
        </p>
      </div>

      <div className="stat order" data-testid="tile-headroom" title={o.order.rotates ? ORDER_HELP.rotates : ORDER_HELP.ranked}>
        <h2>{o.order.rotates ? 'Serve order · rotates' : 'Serve order'}</h2>{' '}
        {o.order.lines.length === 0 ? (
          <p className="stat-sub order-none">No accounts yet</p>
        ) : (
          <>
            <span className="order-col">{leftLabel('Session')}</span> <span className="order-col">{leftLabel('Weekly')}</span>{' '}
            <ol className="order-lines">
              {o.order.lines.map((l) => (
                <li className="order-line" key={l.account}>
                  <span className="order-rank num">{l.kind !== 'in_line' ? '–' : o.order.rotates ? '' : l.rank}</span>{' '}
                  <span className="order-who">{who(l.account, l.email)}</span> {place(l)}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function place(l: ServeLine) {
  switch (l.kind) {
    case 'in_line':
      return l.session === null && l.weekly === null ? (
        <span className="order-status muted">not read yet</span>
      ) : (
        <>
          <span className="order-left num">{percent(l.session)}</span> <span className="order-left num">{percent(l.weekly)}</span>
        </>
      );
    case 'blocked':
      return (
        <span className="order-status blocked" title={reasonTitle(l.reason)}>
          {l.until === null ? (
            'blocked'
          ) : (
            <>
              blocked until <Clock at={l.until} />
            </>
          )}
        </span>
      );
    case 'disabled':
      return <span className="order-status muted">disabled</span>;
  }
}
