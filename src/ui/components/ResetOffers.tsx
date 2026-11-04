import type { GrantId, ProgramId } from '../../shared/domain';
import type { AccountView, OfferView } from '../../shared/view';
import { usePaused } from '../deck';
import { claimResultText } from '../format';
import { Age, Clock, Countdown } from './Countdown';

export function ResetOffers(props: { readonly account: AccountView; readonly onClaim: (program: ProgramId, grant: GrantId | null) => void }) {
  const rows = props.account.offers.map((o) => (
    <OfferRow key={o.program} offer={o} onClaim={() => props.onClaim(o.program, o.state.kind === 'claimable' ? o.state.grant : null)} />
  ));
  const quiet = props.account.quietOffers;
  if (quiet !== null) {
    return (
      <details className="offers-quiet" aria-label="Claude resets">
        <summary>
          <span className="offers-title">Claude resets</span>
          {quiet.map((phrase) => (
            <span key={phrase} className="offers-phrase">
              {phrase}
            </span>
          ))}
        </summary>
        <div className="offers-rows">{rows}</div>
      </details>
    );
  }
  return (
    <section className="offers" aria-label="Claude resets">
      <h4>Claude resets</h4>
      {rows}
    </section>
  );
}

function OfferRow(props: { readonly offer: OfferView; readonly onClaim: () => void }) {
  const o = props.offer;
  const paused = usePaused();
  return (
    <div className={`offer offer-${o.state.kind}`} data-testid={`offer-${o.program}`}>
      <span className="offer-label" title={o.program}>
        {o.label}
      </span>
      <span className="offer-state">
        <OfferState offer={o} />
      </span>
      {o.state.kind === 'claimable' && (
        <button type="button" className="btn accent" onClick={props.onClaim} disabled={paused !== null} title={paused ?? undefined} data-testid={`claim-${o.program}`}>
          Claim…
        </button>
      )}
      {o.grants.length > 0 && (
        <ul className="grants">
          {o.grants.map((g) => (
            <li key={g.id} className={g.usable ? 'usable' : 'muted'}>
              “{g.label}” <span className="num">{g.resetsLeft}</span> of <span className="num">{g.resetsTotal}</span> left
              {g.clears.length > 0 && (
                <>
                  {' · clears '}
                  <span title={g.clears.join(', ')}>{g.clearsText}</span>
                </>
              )}
              {g.endsAt !== null && (
                <>
                  {' · ends '}
                  <Clock at={g.endsAt} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OfferState(props: { readonly offer: OfferView }) {
  const s = props.offer.state;
  switch (s.kind) {
    case 'claimable':
      return <span className="badge good">● Claimable</span>;
    case 'held':
      return (
        <span>
          Offered when at limit
          {s.lastAt !== null && (
            <span className="muted">
              {' · '}last read {s.lastClaimable ? 'claimable' : 'not claimable'}, <Age at={s.lastAt} /> ago
            </span>
          )}
        </span>
      );
    case 'waiting':
      return s.until === null ? (
        <span>Paused</span>
      ) : (
        <span>
          Next at <Clock at={s.until} /> <span className="muted">(in <Countdown at={s.until} />)</span>
        </span>
      );
    case 'ineligible':
      return (
        <span title={s.explain === s.reason ? s.explain : `${s.explain} (${s.reason})`}>
          Not eligible <span className="muted">· {s.explain}</span>
        </span>
      );
    case 'not_enrolled':
      return <span className="muted">Not enrolled</span>;
    case 'in_flight':
      if (s.phase === 'maybe_sent') return <span className="badge warning">! Outcome unknown, checking</span>;
      return (
        <span>
          <span className="spinner" aria-hidden /> {s.phase === 'sending' ? 'Claiming…' : `${s.result === 'reset' ? 'Claimed' : `Last claim: ${claimResultText(s.result ?? 'unknown')}`}, waiting for a fresh read`}
        </span>
      );
    case 'unknown':
      return <span className="muted">{s.why === 'failing' ? 'Read failing, see the status line above' : 'No data yet'}</span>;
  }
}
