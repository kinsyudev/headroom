import { useEffect, useRef, useState } from 'react';
import type { ClaimRecord, GrantId, ProgramId } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { useAction } from '../api';
import { usePaused } from '../deck';
import { claimText } from '../format';
import { Age, Clock, Countdown } from './Countdown';

export function ClaimDialog(props: {
  readonly account: AccountView;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
  readonly onClose: () => void;
}) {
  const a = props.account;
  const claim = useAction('claim');
  const paused = usePaused();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [record, setRecord] = useState<ClaimRecord | null>(null);
  const offer = a.offers.find((o) => o.program === props.program)!;
  const grant = offer.grants.find((g) => g.id === props.grant) ?? null;
  const stillClaimable = offer.state.kind === 'claimable';
  const confirmLabel =
    props.program === 'juniper_tide' ? `Reset session limit on ${a.email}` : `Use 1 “${grant?.label ?? 'bonus'}” reset on ${a.email}`;

  useEffect(() => {
    const opener = document.activeElement;
    close.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return props.onClose();
      if (e.key !== 'Tab') return;
      const stops = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled)'));
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const last = stops.length - 1;
      e.preventDefault();
      stops[e.shiftKey ? (at <= 0 ? last : at - 1) : at === last ? 0 : at + 1]!.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  const done = record !== null || claim.status.phase === 'error';
  useEffect(() => {
    if (done) close.current?.focus();
  }, [done]);
  const tone = record?.state.kind === 'settled' && record.state.outcome.result === 'reset' ? 'good' : record?.state.kind === 'maybe_sent' ? 'warning' : 'neutral';

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        props.onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="claim-title claim-name" data-testid="claim-dialog" ref={dialog}>
        <h2 id="claim-title">Claim a reset</h2>
        <dl className="facts">
          <dt>Account</dt>
          <dd>
            {a.email} <span className="muted">· {a.plan?.label ?? 'plan unknown'}</span>
          </dd>
          <dt>Reset type</dt>
          <dd>
            <span id="claim-name" title={props.program}>
              {offer.name}
            </span>
          </dd>
          {grant && (
            <>
              <dt>Bonus</dt>
              <dd>
                “{grant.label}” · <span className="num">{grant.resetsLeft}</span> of <span className="num">{grant.resetsTotal}</span> left, {grant.resetsLeft - 1} after this
              </dd>
            </>
          )}
          <dt>Effect</dt>
          <dd>{offer.effect}</dd>
          {offer.selfResets.length > 0 && (
            <>
              <dt>Without it</dt>
              <dd>
                {offer.selfResets.map((r, i) => (
                  <span key={r.what}>
                    {i > 0 && ' and '}
                    {r.what} resets on its own at <Clock at={r.at} /> <span className="muted">(in <Countdown at={r.at} />)</span>
                  </span>
                ))}
                .
              </dd>
            </>
          )}
          <dt>Based on</dt>
          <dd>
            reset data from <Age at={offer.dataAt} /> ago. Headroom reads Anthropic again before sending and sends nothing unless it still says claimable.
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
          <button type="button" className="btn quiet" onClick={props.onClose} data-testid="claim-close" ref={close}>
            {done ? 'Close' : claim.pending ? 'Close (the claim continues)' : 'Cancel'}
          </button>
          {!done && (
            <button
              type="button"
              className="btn danger"
              disabled={claim.pending || !stillClaimable || paused !== null}
              title={paused ?? undefined}
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
