import type { Instant } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { reasonText } from '../format';
import { Clock, Countdown } from './Countdown';
import { Segments } from './Segments';

export function Trouble(props: { readonly account: AccountView }) {
  const { trouble, cooldowns, statusMessage } = props.account;
  if (trouble === null) return null;
  return (
    <div className="trouble">
      <p className="cooldown">
        <Segments
          parts={[
            <strong>{trouble.cause}</strong>,
            ...(trouble.holds.length === 0
              ? [<span className="muted">CPA&apos;s last error, no cooldown running</span>]
              : trouble.holds.map((h) => (
                  <>
                    {h.what}
                    <Until at={h.until} />
                  </>
                ))),
          ]}
        />
      </p>
      {(cooldowns.length > 0 || statusMessage !== null) && (
        <details>
          <summary>Details</summary>
          <ul>
            {cooldowns.map((c, i) => (
              <li key={i}>
                <strong>{c.scope === 'credential' ? 'Account' : c.model}</strong> <code title={reasonText(c.reason)}>{c.reason}</code>
                <Until at={c.retryAt} />
              </li>
            ))}
          </ul>
          {statusMessage !== null && <p className="status-message">CPA said: “{statusMessage}”</p>}
        </details>
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
        until <Clock at={props.at} /> <span className="muted">(<Countdown at={props.at} />)</span>
      </span>
    </>
  );
}
