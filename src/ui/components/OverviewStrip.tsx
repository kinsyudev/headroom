import type { AccountId } from '../../shared/domain';
import type { DeckView, Headroom } from '../../shared/view';
import { clockTime } from '../format';
import { Age, Clock, Countdown } from './Countdown';
import { resetsAnchor } from './ResetOffers';
import { Segments } from './Segments';

const ROOM_HELP =
  'Room left across the enabled accounts: the average of their Session figures and the average of their Weekly figures, an idle session counting as 100% left. “Most room” names the enabled account that can take the most, since a session cannot use more than the week has left.';

export function OverviewStrip(props: { readonly deck: DeckView; readonly colors: ReadonlyMap<AccountId, string> }) {
  const o = props.deck.overview;
  const { cpa, now } = props.deck;
  const down = cpa.kind === 'down';
  const answeredAt = cpa.kind === 'down' && cpa.lastAt !== null ? ` (CPA last answered at ${clockTime(cpa.lastAt, now)})` : '';
  const heading = (label: string) => (
    <div className="stat-head">
      <h2>{label}</h2>
      {down && (
        <span className="asof" title={`CPA is not answering, so this is the last value Headroom has${answeredAt}.`}>
          last known
        </span>
      )}
    </div>
  );
  const swatch = (id: AccountId) => <span className="swatch small" style={{ background: props.colors.get(id) }} aria-hidden />;
  const [lead, ...alsoServing] = o.serving;
  const nextSession = !o.target ? (
    <span className="badge critical">No account can take traffic</span>
  ) : lead?.takesNext ? (
    'takes the next new session'
  ) : (
    <>
      next new session on {swatch(o.target.account)} {o.target.email}
    </>
  );
  const claimAccounts = o.claimable;
  return (
    <section className="summary" aria-label="Overview" data-testid="overview">
      <div
        className="stat serving"
        data-testid="tile-serving"
        title={`Evidence: ${o.servingEvidence === 'keeper' ? 'the request log behind History' : 'CPA response headers (the request log is unavailable)'}`}
      >
        {heading('Serving now')}
        {lead ? (
          <p className="hero hero-id" title={lead.email}>
            {swatch(lead.account)}
            <span className="hero-text">{lead.email}</span>
          </p>
        ) : (
          <p className="hero muted">Idle</p>
        )}
        <p className="stat-sub">
          <Segments
            parts={[
              lead ? (
                down ? (
                  <>
                    last request at <Clock at={lead.lastAt} />
                  </>
                ) : (
                  <>
                    last request <Age at={lead.lastAt} /> ago
                  </>
                )
              ) : (
                'nothing answered in the last 2 min'
              ),
              nextSession,
              alsoServing.length > 0 && <>also {alsoServing.map((s) => s.email).join(', ')}</>,
            ]}
          />
        </p>
      </div>

      <div className="stat" data-testid="tile-next-reset">
        {heading('Next reset')}
        {o.nextReset ? (
          <>
            <p className="hero num">
              <Countdown at={o.nextReset.at} />
            </p>
            <p className="stat-sub">
              <Segments
                parts={[
                  <>
                    {swatch(o.nextReset.account)} {o.nextReset.email}
                  </>,
                  <>
                    {o.nextReset.label.toLowerCase()} resets <Clock at={o.nextReset.at} />
                  </>,
                  o.nextReset.unblocks && 'unblocks then',
                  o.nextUnblock && (
                    <>
                      {o.nextUnblock.email} unblocks at <Clock at={o.nextUnblock.at} />
                    </>
                  ),
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
        {heading('Claimable resets')}
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
                  {swatch(g.account)} {g.resets.length === 1 ? 'Review' : `Review ${g.resets.length}`} on {g.email} ↓
                </a>
              ))}
            />
          )}
        </p>
      </div>

      <div className="stat rooms" data-testid="tile-headroom" title={ROOM_HELP}>
        {heading('Room left')}
        <p className="hero room-pair num">
          <Room label="session" h={o.headroom.session} /> <Room label="weekly" h={o.headroom.weekly} />
        </p>{' '}
        <p className="stat-sub">
          <Segments
            parts={[
              `average of ${o.headroom.session.of} ${o.headroom.session.of === 1 ? 'account' : 'accounts'}`,
              o.headroom.session.unknown > 0 && <span className="muted">{o.headroom.session.unknown} not read yet</span>,
              o.headroom.session.most && o.headroom.session.of > 1 && (
                <>
                  most room on {swatch(o.headroom.session.most.account)}{' '}
                  <span title={o.headroom.session.most.email}>{o.headroom.session.most.email.split('@')[0]}</span>
                </>
              ),
            ]}
          />
        </p>
      </div>
    </section>
  );
}

function Room(props: { readonly label: string; readonly h: Headroom }) {
  return (
    <span className="room">
      {props.h.percent === null ? '—' : `${props.h.percent}%`}
      <span className="room-label"> {props.label}</span>
    </span>
  );
}
