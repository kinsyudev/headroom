import type { CSSProperties } from 'react';
import type { Severity } from '../../shared/domain';
import type { LimitView, SpendView } from '../../shared/view';
import { useNow } from '../deck';
import { age, money, percent } from '../format';
import { Clock, Countdown } from './Countdown';

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
  const now = useNow();
  const l = props.limit;
  const readings = [
    `${SOURCE[l.source.kind]} ${age(now - l.source.at)} ago`,
    l.other && `${SOURCE[l.other.kind]} ${percent(l.other.percent)} ${age(now - l.other.at)} ago`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`limit phase-${l.phase}`} data-testid={`limit-${l.key}`} title={readings}>
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
          <>
            <span className="nowrap">
              resets <Clock at={l.resetsAt} />
              {'\u00A0·'}
            </span>{' '}
            <span className="nowrap limit-in">
              in <Countdown at={l.resetsAt} />
            </span>
          </>
        )}
        {l.phase === 'lapsed' && l.resetsAt !== null && (
          <>
            <span className="nowrap">
              reset <Clock at={l.resetsAt} /> ✓{'\u00A0·'}
            </span>{' '}
            <span className="nowrap">awaiting fresh data</span>
          </>
        )}
        {l.phase === 'idle' && <span>no session window running</span>}
      </span>
    </div>
  );
}

type Overage = NonNullable<SpendView['live']>;

const overage = (o: Overage) => ['overage', percent(o.percent), o.status, o.reason && `(${o.reason})`].filter(Boolean).join(' ');

export function SpendRow(props: { readonly spend: SpendView | null; readonly atWall: boolean }) {
  const now = useNow();
  const s = props.spend;
  if (!s) return null;
  const p = s.poll;
  const live = s.live;
  const off = p ? `off${p.disabledReason ? ` · ${p.disabledReason}` : ''}` : props.atWall ? 'not read at the wall' : 'not read yet';
  const notable = live !== null && live.severity !== 'normal' && (p === null || p.enabled);
  const readings = [p && `poll ${age(now - p.at)} ago`, live && `${overage(live)}, live ${age(now - live.at)} ago`].filter(Boolean).join(' · ');
  return (
    <div className="limit spend" data-testid="spend" title={readings}>
      <span className="limit-label">Extra usage</span>
      {p?.enabled ? (
        <>
          <Meter percent={p.percent} severity={p.severity} label="Extra usage spent" />
          <span className="limit-value num">{percent(p.percent)}</span>
          <span className="limit-reset num">
            {money(p.used)}
            {p.limit ? ` / ${money(p.limit)}` : ''}
          </span>
          {notable && <span className="spend-note">{overage(live)}</span>}
        </>
      ) : (
        <span className="spend-note">{notable ? `${off} · ${overage(live)}` : off}</span>
      )}
    </div>
  );
}
