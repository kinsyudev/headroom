import type { AccountId } from '../../shared/domain';
import type { DeckView, RoomView } from '../../shared/view';
import { percent } from '../format';
import { Age, Clock, Countdown } from './Countdown';
import { resetsAnchor } from './ResetOffers';
import { Segments } from './Segments';

const ROOM_HELP =
  'Accounts open: the enabled accounts CPA can send a request to now, neither blocked nor at a limit. Under it, the open accounts in the order traffic reaches them, with the room their session and weekly windows have left.';

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
  const blocked = (id: AccountId, email: string) => (
    <>
      <span className="badge critical">■ Blocked</span> {who(id, email)}
    </>
  );
  const [lead, ...alsoServing] = o.serving;
  const nextSession = !o.target ? (
    <span className="badge critical">No account can take traffic</span>
  ) : lead?.takesNext ? (
    'takes the next new session'
  ) : (
    <>
      next new session on {who(o.target.account, o.target.email)}
    </>
  );
  const claimAccounts = o.claimable;
  const shownRoom = o.room.open.slice(0, 2);
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
              alsoServing.length > 0 && <>also {alsoServing.map((s) => s.email.split('@')[0]).join(', ')}</>,
            ]}
          />
        </p>
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
                parts={
                  o.nextReset.unblocks
                    ? [
                        blocked(o.nextReset.account, o.nextReset.email),
                        `${o.nextReset.label.toLowerCase()} limit`,
                        <>
                          unblocks <Clock at={o.nextReset.at} />
                        </>,
                      ]
                    : [
                        who(o.nextReset.account, o.nextReset.email),
                        <>
                          {o.nextReset.label.toLowerCase()} resets <Clock at={o.nextReset.at} />
                        </>,
                      ]
                }
              />
            </p>
          </>
        ) : (
          <>
            <p className="hero muted">—</p>
            <p className="stat-sub">No window with a known reset</p>
          </>
        )}
        {o.nextUnblock && (
          <p className="stat-sub">
            <Segments
              parts={[
                blocked(o.nextUnblock.account, o.nextUnblock.email),
                <>
                  unblocks <Clock at={o.nextUnblock.at} />
                </>,
              ]}
            />
          </p>
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

      <div className="stat" data-testid="tile-headroom" title={ROOM_HELP}>
        <h2>Room left</h2>
        {o.room.of === 0 ? (
          <>
            <p className="hero muted">—</p>
            <p className="stat-sub">No account is enabled</p>
          </>
        ) : (
          <>
            <p className="hero num">
              {o.room.open.length} of {o.room.of}
              <span className="room-label"> accounts open</span>
            </p>
            {shownRoom.length === 0 && <p className="stat-sub">None can take a request now</p>}
            {shownRoom.map((r, i) => (
              <p className="stat-sub room-line" key={r.account}>
                <Segments
                  parts={[
                    <>
                      {r.serving ? 'serving' : shownRoom.slice(0, i).some((x) => !x.serving) ? 'then' : 'next'} {who(r.account, r.email)}
                    </>,
                    ...roomFigures(r),
                  ]}
                />
              </p>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function roomFigures(r: RoomView['open'][number]) {
  if (r.session === null && r.weekly === null) return [<span className="muted">not read yet</span>];
  return [`${percent(r.session)} session`, `${percent(r.weekly)} weekly`];
}
