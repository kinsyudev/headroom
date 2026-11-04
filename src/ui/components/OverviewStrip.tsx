import type { AccountId, GrantId, ProgramId } from '../../shared/domain';
import type { DeckView, Headroom } from '../../shared/view';
import { ClaimButton } from './ClaimButton';
import { Age, Clock, Countdown } from './Countdown';
import { Meter } from './LimitRow';
import { Segments } from './Segments';

export function OverviewStrip(props: {
  readonly deck: DeckView;
  readonly colors: ReadonlyMap<AccountId, string>;
  readonly onClaim: (account: AccountId, program: ProgramId, grant: GrantId | null) => void;
}) {
  const o = props.deck.overview;
  const swatch = (id: AccountId) => <span className="swatch small" style={{ background: props.colors.get(id) }} aria-hidden />;
  const [lead, ...alsoServing] = o.serving;
  const nextSession = !o.target ? (
    <span className="badge critical">No account can take traffic</span>
  ) : lead?.takesNext ? (
    'also takes the next new session'
  ) : (
    <>next new session → {swatch(o.target.account)} {o.target.email}</>
  );
  return (
    <section className="overview" aria-label="Overview" data-testid="overview">
      <div
        className="tile serving"
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
        <p className="tile-sub">
          <Segments
            parts={[
              lead ? (
                <>
                  last request <Age at={lead.lastAt} /> ago
                </>
              ) : (
                'nothing answered in the last 2 min'
              ),
              nextSession,
            ]}
          />
        </p>
        {alsoServing.length > 0 && (
          <p className="tile-sub muted clip">
            also serving{' '}
            {alsoServing.map((s, i) => (
              <span key={s.account}>
                {i > 0 && ', '}
                {swatch(s.account)} {s.email}
              </span>
            ))}
          </p>
        )}
      </div>

      <div className="tile" data-testid="tile-next-reset">
        <h2>Next reset</h2>
        {o.nextReset ? (
          <>
            <p className="hero num">
              <Countdown at={o.nextReset.at} />
            </p>
            <p className="tile-sub">
              <Segments
                parts={[
                  <>
                    {swatch(o.nextReset.account)} {o.nextReset.email}
                  </>,
                  <>
                    {o.nextReset.label} at <Clock at={o.nextReset.at} />
                  </>,
                  o.nextReset.unblocks && 'unblocks then',
                ]}
              />
            </p>
          </>
        ) : (
          <p className="tile-main muted">No window with a known reset</p>
        )}
        {o.nextUnblock && (
          <p className="tile-foot">
            {swatch(o.nextUnblock.account)} {o.nextUnblock.email} unblocks at <Clock at={o.nextUnblock.at} />{' '}
            <span className="muted">
              (<Countdown at={o.nextUnblock.at} />)
            </span>
          </p>
        )}
      </div>

      <div className="tile" data-testid="tile-claimable">
        <h2>Claimable resets</h2>
        <p className="hero num">{o.claimableCount}</p>
        {o.claimable.length === 0 ? (
          <p className="tile-sub muted">None right now. Weekly session resets are checked when an account hits its limit.</p>
        ) : (
          o.claimable.map((g) => (
            <div key={g.account} className="claim-group">
              <h3 className="claim-account clip">
                {swatch(g.account)} {g.email}
              </h3>
              <ul className="claimable">
                {g.resets.map((r) => (
                  <li key={r.program}>
                    <span className="claim-name">
                      {r.name}
                      {r.detail && <span className="muted nowrap"> ({r.detail})</span>}
                    </span>
                    <ClaimButton name={r.name} email={g.email} testId={`overview-claim-${r.program}`} onClick={() => props.onClaim(g.account, r.program, r.grant)} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <div
        className="tile rooms"
        data-testid="tile-headroom"
        role="group"
        aria-label="Headroom"
        title="Room left, counted in whole accounts. Each enabled account counts as 1.00 when all of its room is left. Session room is capped by each account's weekly room."
      >
        <Room label="Session room" h={o.headroom.session} />
        <Room label="Weekly room" h={o.headroom.weekly} />
      </div>
    </section>
  );
}

function Room(props: { readonly label: string; readonly h: Headroom }) {
  const { value, of, unknown } = props.h;
  return (
    <div className="room">
      <h2>{props.label}</h2>
      <p className="hero num">{value.toFixed(2)}</p>{' '}
      <p className="tile-sub">
        <Segments parts={[`of ${of} ${of === 1 ? 'account' : 'accounts'}`, unknown > 0 && <span className="muted">{unknown} unknown</span>]} />
      </p>
      <Meter percent={of > unknown ? (value / of) * 100 : null} severity="normal" label={props.label} />
    </div>
  );
}
