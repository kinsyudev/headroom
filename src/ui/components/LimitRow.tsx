import type { CSSProperties } from 'react';
import type { Severity } from '../../shared/domain';
import type { LimitView, SpendView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, duration, money, percent, reasonText } from '../format';
import { Segments } from './Segments';

const FILL: Readonly<Record<Severity, string>> = { normal: 'var(--muted)', warning: 'var(--warning)', critical: 'var(--critical)' };
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

function resetText(l: LimitView, now: number): { readonly first: string; readonly second: string; readonly title: string } | null {
  if (l.resetsAt === null) return null;
  const at = clockTime(l.resetsAt, now);
  switch (l.phase) {
    case 'open': {
      const left = duration(l.resetsAt - now);
      return { first: left, second: at, title: `resets ${at} · in ${left}` };
    }
    case 'lapsed':
      return { first: `${at} ✓`, second: 'awaiting data', title: `reset ${at} ✓ · awaiting fresh data` };
    case 'idle':
      return null;
  }
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
  const reset = resetText(l, now);
  return (
    <div className={`limit phase-${l.phase}`} data-testid={`limit-${l.key}`} title={readings}>
      <span className="limit-label">
        {l.label}
        {l.limiting && (
          <span className="tag" title="The limit that is holding this account back right now">
            limiting
          </span>
        )}
      </span>
      <Meter percent={l.phase === 'open' ? l.percent : null} severity={l.severity} label={`${l.label} used`} tick={l.other?.percent ?? null} />
      <span className="limit-value num" data-testid="percent">
        {l.phase === 'open' ? percent(l.percent) : l.phase === 'idle' ? 'idle' : '—'}
      </span>
      <span className="limit-reset" title={reset?.title}>
        {reset && (
          <>
            <span className="nowrap limit-in num">
              {reset.first}
              <span className="limit-sep">{'\u00A0·'}</span>
            </span>{' '}
            <span className="nowrap limit-at num">{reset.second}</span>
          </>
        )}
        {l.phase === 'idle' && 'no window running'}
      </span>
    </div>
  );
}

type Overage = NonNullable<SpendView['live']>;

const OVERAGE_STATUS: Readonly<Record<string, string>> = { allowed: 'allowed', allowed_warning: 'allowed, near the cap', rejected: 'rejected' };

const overage = (o: Overage) =>
  [o.percent !== null && percent(o.percent), o.status && (OVERAGE_STATUS[o.status] ?? o.status), o.reason && `(${reasonText(o.reason)})`].filter(Boolean).join(' ');

export function SpendRow(props: { readonly spend: SpendView | null; readonly atWall: boolean }) {
  const now = useNow();
  const s = props.spend;
  if (!s) return null;
  const p = s.poll;
  const live = s.live;
  const off = p ? ['off', p.disabledReason && reasonText(p.disabledReason)] : [props.atWall ? 'not read at limit' : 'not read yet'];
  const notable = live !== null && live.severity !== 'normal' && (p === null || p.enabled);
  const codes = [...new Set([p?.disabledReason, live?.reason].filter(Boolean))];
  const readings = [p && `poll ${age(now - p.at)} ago`, live && `${overage(live)}, live ${age(now - live.at)} ago`, codes.length > 0 && `reason code: ${codes.join(', ')}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="limit spend" data-testid="spend" title={readings}>
      <span className="limit-label">Extra usage</span>
      {p?.enabled ? (
        <>
          <Meter percent={p.percent} severity={p.severity} label="Extra usage spent" />
          <span className="limit-value num">{percent(p.percent)}</span>
          <span className="limit-reset num nowrap">{p.limit ? `${money(p.used)} / ${money(p.limit)}` : money(p.used)}</span>
          {notable && <span className="spend-note">{overage(live)}</span>}
        </>
      ) : (
        <span className="spend-note">
          <Segments parts={[...off, notable && overage(live)]} />
        </span>
      )}
    </div>
  );
}
