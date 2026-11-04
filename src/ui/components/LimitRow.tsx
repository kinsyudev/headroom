import type { CSSProperties } from 'react';
import type { Severity } from '../../shared/domain';
import type { LimitView, SpendView } from '../../shared/view';
import { money, percent } from '../format';
import { Age, Clock, Countdown } from './Countdown';

const FILL: Readonly<Record<Severity, string>> = { normal: 'var(--accent)', warning: 'var(--warning)', critical: 'var(--critical)' };
const SOURCE: Readonly<Record<'poll' | 'headers', string>> = { poll: 'poll', headers: 'live' };

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function Meter(props: { readonly percent: number | null; readonly severity: Severity; readonly label: string; readonly tick?: number | null }) {
  return (
    <div
      className="meter"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.percent ?? undefined}
      style={{ '--fill': FILL[props.severity] } as CSSProperties}
    >
      {props.percent !== null && props.percent > 0 && <div className="meter-fill" style={{ width: `${clamp(props.percent)}%` }} />}
      {props.tick != null && <div className="meter-tick" style={{ left: `${clamp(props.tick)}%` }} />}
    </div>
  );
}

export function LimitRow(props: { readonly limit: LimitView }) {
  const l = props.limit;
  return (
    <div className={`limit phase-${l.phase}`} data-testid={`limit-${l.key}`}>
      <span className="limit-label">
        {l.label}
        {l.isActive && <span className="tag">binding</span>}
      </span>
      <Meter percent={l.phase === 'open' ? l.percent : null} severity={l.severity} label={`${l.label} used`} tick={l.other?.percent ?? null} />
      <span className="limit-value num" data-testid="percent">
        {l.phase === 'open' ? percent(l.percent) : l.phase === 'idle' ? 'idle' : '—'}
      </span>
      <span className="limit-reset">
        {l.phase === 'open' && l.resetsAt !== null && (
          <span title={new Date(l.resetsAt).toLocaleString()}>
            ↻ <Countdown at={l.resetsAt} />
          </span>
        )}
        {l.phase === 'lapsed' && l.resetsAt !== null && (
          <span>
            reset <Clock at={l.resetsAt} /> ✓
          </span>
        )}
      </span>
      <span className="limit-source">
        {l.phase === 'lapsed' && <span className="lapsed-note">awaiting fresh data · </span>}
        {l.phase === 'idle' && <span>no session window running · </span>}
        <span className={`src src-${l.source.kind}`}>
          {SOURCE[l.source.kind]} <Age at={l.source.at} />
        </span>
        {l.other && (
          <span className="other">
            {' '}
            · {SOURCE[l.other.kind]} {percent(l.other.percent)} <Age at={l.other.at} /> ago
          </span>
        )}
        {l.phase === 'open' && l.resetsAt !== null && (
          <span className="muted">
            {' '}
            · resets <Clock at={l.resetsAt} />
          </span>
        )}
      </span>
    </div>
  );
}

export function SpendRow(props: { readonly spend: SpendView | null }) {
  const s = props.spend;
  if (!s) return null;
  const p = s.poll;
  return (
    <div className="limit spend" data-testid="spend">
      <span className="limit-label">Extra usage</span>
      {p?.enabled ? (
        <>
          <Meter percent={p.percent} severity={p.severity} label="Extra usage spent" />
          <span className="limit-value num">{percent(p.percent)}</span>
          <span className="limit-reset num">
            {money(p.used)}
            {p.limit ? ` / ${money(p.limit)}` : ''}
          </span>
        </>
      ) : (
        <span className="spend-off">{p ? `off${p.disabledReason ? ` · ${p.disabledReason}` : ''}` : 'not read at the wall'}</span>
      )}
      <span className="limit-source">
        {p && (
          <span className="src src-poll">
            poll <Age at={p.at} />
          </span>
        )}
        {s.live && (
          <span className="other">
            {p ? ' · ' : ''}overage {percent(s.live.percent)} {s.live.status ?? ''}
            {s.live.reason ? ` (${s.live.reason})` : ''} · live <Age at={s.live.at} />
          </span>
        )}
      </span>
    </div>
  );
}
