import { useEffect, useState, type ReactNode } from 'react';
import type { GrantId, ProgramId } from '../../shared/domain';
import type { AccountView, ClaimVerdict, GrantView, OfferView } from '../../shared/view';
import { useNow } from '../deck';
import { claimResultText, claimVerdictText } from '../format';
import { ClaimButton } from './ClaimButton';
import { Age, Clock, Countdown } from './Countdown';
import { Segments } from './Segments';

export const resetsAnchor = (account: string) => `resets-${account}`;

export function VerdictLine(props: { readonly verdict: ClaimVerdict; readonly email: string; readonly back: boolean }) {
  const { lead, rest } = claimVerdictText(props.verdict, props.email, useNow(), props.back);
  return (
    <span className="verdict" data-testid="claim-verdict">
      <strong>{lead}:</strong> {rest}
    </span>
  );
}

const CLAIM_EVENT = 'headroom:claim-mode';

/** Asks an account's resets panel to show its Claim buttons, as following the overview's "Review" link does. */
export function openClaimMode(account: string): void {
  window.dispatchEvent(new CustomEvent(CLAIM_EVENT, { detail: account }));
}

function useClaimMode(account: string): readonly [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const open = (e: Event) => {
      if ((e as CustomEvent<string>).detail === account) setOn(true);
    };
    window.addEventListener(CLAIM_EVENT, open);
    return () => window.removeEventListener(CLAIM_EVENT, open);
  }, [account]);
  return [on, setOn];
}

/** One summary line until the operator asks to claim; only then the verdict, every grant and the Claim buttons. */
export function ResetOffers(props: { readonly account: AccountView; readonly verdict: ClaimVerdict | null; readonly onClaim: (program: ProgramId, grant: GrantId | null) => void }) {
  const a = props.account;
  const claimable = a.offers.some((o) => o.state.kind === 'claimable');
  const [open, setOpen] = useClaimMode(a.id);
  const choosing = open && claimable;
  return (
    <div className={claimable ? 'offers claimable' : 'offers'}>
      <h4>
        Resets you can claim
        <span className="offers-note">
          {choosing ? props.verdict && <VerdictLine verdict={props.verdict} email={a.email} back /> : <span data-testid="offers-summary"><Segments parts={[...a.offers].sort((x, y) => Number(y.state.kind === 'claimable') - Number(x.state.kind === 'claimable')).map(summaryOf)} /></span>}
          {claimable && (
            <button type="button" className="btn ghost offers-toggle" aria-expanded={choosing} data-testid="claim-mode" onClick={() => setOpen(!choosing)}>
              {choosing ? 'Done' : 'Claim a reset…'}
            </button>
          )}
        </span>
      </h4>
      {choosing && (
        <div className="offer-list">
          {a.offers.map((o) => (
            <OfferRow key={o.program} email={a.email} offer={o} onClaim={(grant) => props.onClaim(o.program, grant)} />
          ))}
        </div>
      )}
    </div>
  );
}

function summaryOf(o: OfferView): ReactNode {
  const s = o.state;
  switch (s.kind) {
    case 'claimable': {
      if (o.grants.length === 0) return o.name;
      const n = o.grants.filter((g) => g.usable).length;
      return `${n} ${o.short} reset${n === 1 ? '' : 's'}`;
    }
    case 'held':
      return `${o.short} offered at limit`;
    case 'waiting':
      return s.until === null ? `${o.short} paused` : (
        <>
          {o.short} next <Clock at={s.until} />
        </>
      );
    case 'in_flight':
      return s.phase === 'maybe_sent' ? `${o.short}: outcome unknown, checking` : `${o.short}: ${s.phase === 'sending' ? 'claiming…' : 'waiting for a fresh read'}`;
    case 'unknown':
      return s.why === 'failing' ? `${o.short}: read failing` : null;
    case 'ineligible':
    case 'not_enrolled':
      return null;
  }
}

function OfferRow(props: { readonly email: string; readonly offer: OfferView; readonly onClaim: (grant: GrantId | null) => void }) {
  const o = props.offer;
  const several = o.grants.length > 1;
  const claimable = o.state.kind === 'claimable' ? o.state : null;
  return (
    <div className={`offer offer-${o.state.kind}`} data-testid={`offer-${o.program}`}>
      <strong className="offer-name" title={o.program}>
        {o.name}
      </strong>
      <div className="offer-text">
        {o.grants.length === 1 && <Segments parts={grantTerms(o.grants[0]!, false)} />}
        {several && (
          <ul className="grants">
            {o.grants.map((g) => (
              <li key={g.id} className={g.usable ? 'usable' : 'muted'}>
                <Segments parts={grantTerms(g, true)} />
                {claimable && g.usable && (
                  <ClaimButton name={g.label} short="this" email={props.email} testId={`claim-${o.program}-${g.id}`} onClick={() => props.onClaim(g.id)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {claimable ? (
        !several && <ClaimButton name={o.name} short={o.short} email={props.email} testId={`claim-${o.program}`} onClick={() => props.onClaim(claimable.grant)} />
      ) : (
        <div className="offer-state">
          <OfferState offer={o} />
        </div>
      )}
    </div>
  );
}

/** A lone grant's count is in the offer's name, so only a list of several says each one's. */
function grantTerms(g: GrantView, several: boolean): ReactNode[] {
  return [
    several && (
      <>
        “{g.label}” <span className="num">{g.resetsLeft}</span> of <span className="num">{g.resetsTotal}</span> left
      </>
    ),
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
  ];
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
      return <span className="muted">{s.why === 'failing' ? 'Read failing, see the status line below' : 'No data yet'}</span>;
  }
}
