import { useEffect, useState } from 'react';
import type { ClaimRecord, GrantId, ProgramId } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { useAction } from '../api';
import { claimText } from '../format';
import { Age } from './Countdown';

export function ClaimDialog(props: {
  readonly account: AccountView;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
  readonly onClose: () => void;
}) {
  const a = props.account;
  const claim = useAction('claim');
  const [record, setRecord] = useState<ClaimRecord | null>(null);
  const offer = a.offers.find((o) => o.program === props.program)!;
  const grant = offer.grants.find((g) => g.id === props.grant) ?? null;
  const stillClaimable = offer.state.kind === 'claimable';
  const confirmLabel =
    props.program === 'juniper_tide' ? `Reset session limit on ${a.email}` : `Use 1 “${grant?.label ?? 'grant'}” reset on ${a.email}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const done = record !== null || claim.status.phase === 'error';
  const tone = record?.state.kind === 'settled' && record.state.outcome.result === 'reset' ? 'good' : record?.state.kind === 'maybe_sent' ? 'warning' : 'neutral';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="claim-title" data-testid="claim-dialog">
        <h2 id="claim-title">Claim a Claude reset</h2>
        <dl className="facts">
          <dt>Account</dt>
          <dd>
            {a.email} <span className="muted">· {a.plan?.label ?? 'plan unknown'}</span>
          </dd>
          <dt>Program</dt>
          <dd>
            {offer.label} <code>{props.program}</code>
          </dd>
          {grant && (
            <>
              <dt>Grant</dt>
              <dd>
                “{grant.label}” · <span className="num">{grant.resetsLeft}</span> of <span className="num">{grant.resetsTotal}</span> left, {grant.resetsLeft - 1} after this
              </dd>
            </>
          )}
          <dt>Effect</dt>
          <dd>{offer.effect}</dd>
          <dt>Based on</dt>
          <dd>
            reset data from <Age at={offer.dataAt} /> ago. The deck reads Anthropic again before sending and sends nothing unless it still says claimable.
          </dd>
        </dl>
        <p className="irreversible">This cannot be undone. It uses one of this account's resets.</p>

        {claim.pending && (
          <p className="claim-status" role="status">
            <span className="spinner" aria-hidden /> Reading fresh reset data, then claiming. Anthropic's rate limit spaces calls 10 s apart, so this can take half a minute.
          </p>
        )}
        {record && (
          <p className={`claim-status ${tone}`} role="status" data-testid="claim-result">
            {claimText(record)}
          </p>
        )}
        {claim.status.phase === 'error' && (
          <p className="claim-status error" role="alert" data-testid="claim-result">
            {claim.status.code === 'not_claimable' ? `Not claimed, nothing was sent: ${claim.status.message}` : `The claim failed: ${claim.status.message}`}
          </p>
        )}
        {!stillClaimable && !claim.pending && !done && <p className="claim-status warning">No longer claimable in the latest data. Close and check the card.</p>}

        <div className="modal-actions">
          <button type="button" className="btn quiet" onClick={props.onClose} data-testid="claim-close">
            {done ? 'Close' : claim.pending ? 'Close (the claim continues)' : 'Cancel'}
          </button>
          {!done && (
            <button
              type="button"
              className="btn danger"
              disabled={claim.pending || !stillClaimable}
              data-testid="claim-confirm"
              onClick={async () => {
                const out = await claim.run({ account: a.id, program: props.program, ...(props.grant ? { grant: props.grant } : {}) });
                if (out) setRecord(out);
              }}
            >
              {claim.pending ? 'Claiming…' : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
