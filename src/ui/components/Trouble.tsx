import { useId, useState } from 'react';
import type { Instant } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { reasonText } from '../format';
import { ActionButton } from './ActionButton';
import { Clock } from './Countdown';
import { Segments } from './Segments';

export function Trouble(props: { readonly account: AccountView }) {
  const { id, trouble, cooldowns, statusMessage, can } = props.account;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (trouble === null) return null;
  const hasDetails = cooldowns.length > 0 || statusMessage !== null;
  const limit = trouble.limit;
  return (
    <div className="trouble">
      <p className="cooldown">
        <strong>{limit ? `${limit.label} limit reached` : trouble.cause}</strong>{' '}
        <Segments
          parts={
            trouble.holds.length === 0
              ? [<span className="muted">CPA&apos;s last error, no cooldown running</span>]
              : trouble.holds.map((h) => (
                  <>
                    {h.what}
                    {limit && limit.liftsAt !== null ? (
                      <>
                        {' '}
                        until the {limit.label.toLowerCase()} resets{' '}
                        <span className="nowrap">
                          at <Clock at={limit.liftsAt} />
                        </span>
                      </>
                    ) : (
                      <Until at={h.until} />
                    )}
                  </>
                ))
          }
        />
      </p>
      <div className="trouble-actions">
        {hasDetails && (
          <button type="button" className="btn ghost" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
            {open ? 'Hide details' : 'Details'}
            <span aria-hidden>{open ? '▴' : '▾'}</span>
          </button>
        )}
        {can.clearCooldown && (
          <ActionButton
            kind="account.clearCooldown"
            input={{ account: id }}
            title="Clear CPA's local cooldown so it routes to this account again. Does not contact Anthropic."
            pendingLabel="Clearing…"
            done="cooldown cleared"
            testId="clear-cooldown"
          >
            Clear cooldown
          </ActionButton>
        )}
      </div>
      {open && (
        <div className="trouble-details" id={detailsId}>
          <ul>
            {cooldowns.map((c, i) => (
              <li key={i}>
                <strong>{c.scope === 'credential' ? 'Account' : c.model}</strong> {reasonText(c.reason)} <code>{c.reason}</code>
                <Until at={c.retryAt} />
              </li>
            ))}
          </ul>
          {statusMessage !== null && <p className="status-message">CPA said: “{statusMessage}”</p>}
        </div>
      )}
    </div>
  );
}

function Until(props: { readonly at: Instant | null }) {
  if (props.at === null) return null;
  return (
    <>
      {' '}
      <span className="nowrap">
        until <Clock at={props.at} />
      </span>
    </>
  );
}
