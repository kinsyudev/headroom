import type { GrantId, ProgramId } from '../../shared/domain';
import type { AccountView, OfferView } from '../../shared/view';
import { claimResultText, resetNameText } from '../format';
import { ClaimButton } from './ClaimButton';
import { Age, Clock, Countdown } from './Countdown';
import { Segments } from './Segments';

export const resetsAnchor = (account: string) => `resets-${account}`;

export function ResetOffers(props: { readonly account: AccountView; readonly onClaim: (program: ProgramId, grant: GrantId | null) => void }) {
  const a = props.account;
  const claimable = a.offers.some((o) => o.state.kind === 'claimable');
  return (
    <section className={claimable ? 'offers claimable' : 'offers'} aria-label="Claude resets" id={resetsAnchor(a.id)} tabIndex={-1}>
      <h4 style={{ gridRow: `span ${a.offers.length}` }}>Claude resets</h4>
      <div className="offer-rows">
        {a.offers.map((o) => (
          <OfferRow key={o.program} email={a.email} offer={o} onClaim={() => props.onClaim(o.program, o.state.kind === 'claimable' ? o.state.grant : null)} />
        ))}
      </div>
    </section>
  );
}

export function QuietOffers(props: { readonly account: AccountView }) {
  const [summary, ...why] = props.account.quietOffers ?? [];
  return (
    <details className="offers-quiet">
      <summary title={why.join(' · ')}>Resets: {summary}</summary>
      <div className="offers-pop" aria-label="Claude resets">
        <div className="offer-rows">
          {props.account.offers.map((o) => (
            <OfferRow key={o.program} email={props.account.email} offer={o} onClaim={() => undefined} />
          ))}
        </div>
      </div>
    </details>
  );
}

function OfferRow(props: { readonly email: string; readonly offer: OfferView; readonly onClaim: () => void }) {
  const o = props.offer;
  const several = o.grants.length > 1;
  return (
    <div className={`offer offer-${o.state.kind}`} data-testid={`offer-${o.program}`}>
      <span className="offer-label" title={o.program}>
        <strong>{o.name.what}</strong> <span className="offer-source">{o.name.source}</span>
      </span>
      <div className="offer-state">
        <OfferState offer={o} />
        {o.grants.length > 0 && (
          <ul className="grants">
            {o.grants.map((g) => (
              <li key={g.id} className={g.usable ? 'usable' : 'muted'}>
                <Segments
                  parts={[
                    <>
                      {several && <>“{g.label}” </>}
                      <span className="num">{g.resetsLeft}</span> of <span className="num">{g.resetsTotal}</span> left
                    </>,
                    several && g.clears.length > 0 && (
                      <>
                        clears <span title={g.clears.join(', ')}>{g.clearsText}</span>
                      </>
                    ),
                    g.endsAt !== null && (
                      <>
                        ends <Clock at={g.endsAt} />
                      </>
                    ),
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {o.state.kind === 'claimable' ? <ClaimButton name={resetNameText(o.name)} email={props.email} testId={`claim-${o.program}`} onClick={props.onClaim} /> : <span />}
    </div>
  );
}

function OfferState(props: { readonly offer: OfferView }) {
  const s = props.offer.state;
  switch (s.kind) {
    case 'claimable':
      return null;
    case 'held':
      return (
        <Segments
          parts={[
            'Offered when at limit',
            s.lastAt !== null && (
              <span className="muted">
                last read {s.lastClaimable ? 'claimable' : 'not claimable'}, <Age at={s.lastAt} /> ago
              </span>
            ),
          ]}
        />
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
          <Segments parts={['Not eligible', <span className="muted">{s.explain}</span>]} />
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
