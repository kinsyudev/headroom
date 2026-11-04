import type { AccountId, GrantId, ProgramId } from '../../shared/domain';
import type { DeckView, Headroom } from '../../shared/view';
import { usePaused } from '../deck';
import { SERVING_WHY } from '../format';
import { Age, Clock, Countdown } from './Countdown';
import { Meter } from './LimitRow';

export function OverviewStrip(props: {
  readonly deck: DeckView;
  readonly colors: ReadonlyMap<AccountId, string>;
  readonly onClaim: (account: AccountId, program: ProgramId, grant: GrantId | null) => void;
}) {
  const o = props.deck.overview;
  const paused = usePaused();
  const swatch = (id: AccountId) => <span className="swatch small" style={{ background: props.colors.get(id) }} aria-hidden />;
  return (
    <section className="overview" aria-label="Overview" data-testid="overview">
      <div
        className="tile serving"
        data-testid="tile-serving"
        title={`Evidence: ${o.servingEvidence === 'keeper' ? "keeper's request log" : 'CPA response headers (keeper unavailable)'}`}
      >
        <h2>Serving now</h2>
        {o.serving.length === 0 ? (
          <p className="tile-main muted">Idle · nothing answered in the last 2 min</p>
        ) : (
          o.serving.map((s) => (
            <p key={s.account} className="tile-main">
              {swatch(s.account)} <strong>{s.email}</strong>
              <span className="muted">
                {' '}
                · {SERVING_WHY[s.why].long} · last request <Age at={s.lastAt} /> ago
              </span>
            </p>
          ))
        )}
        <p className="tile-sub">
          {o.target ? (
            <>
              Next new session → {swatch(o.target.account)} {o.target.email} <span className="muted">(prediction, {props.deck.strategy ?? 'routing unknown'})</span>
            </>
          ) : (
            <span className="badge critical">No account can take traffic</span>
          )}
        </p>
      </div>

      <div className="tile" data-testid="tile-next-reset">
        <h2>Next reset</h2>
        {o.nextReset ? (
          <>
            <p className="hero num">
              <Countdown at={o.nextReset.at} />
            </p>
            <p className="tile-sub">
              {swatch(o.nextReset.account)} {o.nextReset.email} · {o.nextReset.label} at <Clock at={o.nextReset.at} />
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
        <p className="hero num">{o.claimable.length}</p>
        {o.claimable.length === 0 ? (
          <p className="tile-sub muted">None right now. Weekly session resets are checked when an account hits its limit.</p>
        ) : (
          <ul className="claimable">
            {o.claimable.map((c) => (
              <li key={`${c.account}:${c.program}`}>
                <span>
                  {swatch(c.account)} {c.email} · {c.label}
                </span>
                <button
                  type="button"
                  className="btn accent"
                  onClick={() => props.onClaim(c.account, c.program, c.grant)}
                  disabled={paused !== null}
                  title={paused ?? undefined}
                  data-testid={`overview-claim-${c.program}`}
                >
                  Claim…
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="tile" data-testid="tile-headroom">
        <h2>Headroom</h2>
        <HeadroomRow label="Session" h={o.headroom.session} />
        <HeadroomRow label="Weekly" h={o.headroom.weekly} />
        <p className="tile-foot muted" title="Each enabled account counts as 1.00 when all of its room is left. Session room is capped by each account's weekly room.">
          Room left, counted in whole accounts
        </p>
      </div>
    </section>
  );
}

function HeadroomRow(props: { readonly label: string; readonly h: Headroom }) {
  const known = props.h.of - props.h.unknown;
  return (
    <div className="headroom">
      <span className="limit-label">{props.label}</span>
      <Meter percent={known > 0 ? (props.h.value / props.h.of) * 100 : null} severity="normal" label={`${props.label} headroom`} />
      <span className="headroom-value">
        <strong className="num">{props.h.value.toFixed(2)}</strong> <span className="muted">of {props.h.of}</span>
        {props.h.unknown > 0 && <span className="muted"> · {props.h.unknown} unknown</span>}
      </span>
    </div>
  );
}
