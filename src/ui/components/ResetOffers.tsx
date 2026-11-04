/**
 * "Is a Claude reset available?" for one account, one row per program, with the grants
 * listed under cedar_ember. Claim… opens the confirm dialog; nothing is sent from here.
 */
import type { GrantId, ProgramId } from '../../shared/domain';
import type { AccountView, OfferView } from '../../shared/view';
import { Age, Clock, Countdown } from './Countdown';

export function ResetOffers(props: { readonly account: AccountView; readonly onClaim: (program: ProgramId, grant: GrantId | null) => void }) {
  return (
    <section className="offers" aria-label="Claude resets">
      <h4>Claude resets</h4>
      {props.account.offers.map((o) => (
        <OfferRow key={o.program} offer={o} onClaim={() => props.onClaim(o.program, o.state.kind === 'claimable' ? o.state.grant : null)} />
      ))}
    </section>
  );
}

function OfferRow(props: { readonly offer: OfferView; readonly onClaim: () => void }) {
  const o = props.offer;
  return (
    <div className={`offer offer-${o.state.kind}`} data-testid={`offer-${o.program}`}>
      <span className="offer-label" title={o.program}>
        {o.label}
      </span>
      <span className="offer-state">
        <OfferState offer={o} />
      </span>
      {o.state.kind === 'claimable' && (
        <button type="button" className="btn primary small" onClick={props.onClaim} data-testid={`claim-${o.program}`}>
          Claim…
        </button>
      )}
      {o.grants.length > 0 && (
        <ul className="grants">
          {o.grants.map((g) => (
            <li key={g.id} className={g.usable ? 'usable' : 'muted'}>
              “{g.label}” <span className="num">{g.resetsLeft}</span> of <span className="num">{g.resetsTotal}</span> left
              {g.clears.length > 0 && ` · clears ${g.clears.join(', ')}`}
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
          Offered at the wall
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
        <span title={s.explain}>
          Not eligible <span className="muted">· {s.explain}</span>
        </span>
      );
    case 'not_enrolled':
      return <span className="muted">Not enrolled</span>;
    case 'in_flight':
      if (s.phase === 'unknown') return <span className="badge warning">! Outcome unknown, checking</span>;
      return (
        <span>
          <span className="spinner" aria-hidden /> {s.phase === 'sending' ? 'Claiming…' : `${s.result === 'reset' ? 'Claimed' : `Last claim: ${s.result}`}, waiting for a fresh read`}
        </span>
      );
    case 'unknown':
      return <span className="muted">{s.why === 'failing' ? 'Read failing, see chips below' : 'No data yet'}</span>;
  }
}
