import type { CSSProperties, ReactNode } from 'react';
import type { PercentLeft, Severity } from '../../shared/domain';
import type { LimitView, SpendView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, duration, money, percent, reasonText } from '../format';

const FILL: Readonly<Record<Severity, string>> = { normal: 'var(--muted)', warning: 'var(--warning)', critical: 'var(--critical)' };
const SOURCE: Readonly<Record<'poll' | 'headers', string>> = { poll: 'poll', headers: 'live' };

export function Meter(props: {
  readonly left: PercentLeft | null;
  readonly severity: Severity;
  readonly label: string;
  readonly tick?: { readonly left: PercentLeft; readonly title: string } | null;
}) {
  return (
    <div
      className={`meter sev-${props.severity}`}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.left ?? undefined}
      style={{ '--fill': FILL[props.severity] } as CSSProperties}
    >
      {props.left !== null && props.left > 0 && <div className="meter-fill" style={{ width: `${props.left}%` }} />}
      {props.tick && <div className="meter-tick" style={{ left: `${props.tick.left}%` }} title={props.tick.title} />}
    </div>
  );
}

function Left(props: { readonly left: PercentLeft | null }) {
  return props.left === null ? (
    <>—</>
  ) : (
    <>
      {percent(props.left)}
      <span className="cell-unit"> left</span>
    </>
  );
}

function resetNote(l: LimitView, now: number): { readonly text: string; readonly title: string } | null {
  if (l.phase === 'idle') return { text: 'no window running', title: 'No session window is running, so all of it is left; one starts with the next request' };
  if (l.resetsAt === null) return null;
  const at = clockTime(l.resetsAt, now);
  if (l.phase === 'lapsed') return { text: `${at} ✓ awaiting data`, title: `reset ${at} ✓ · awaiting fresh data` };
  const left = duration(l.resetsAt - now);
  return { text: `${left} · ${at}`, title: `resets ${at}, in ${left}` };
}

export function LimitCell(props: { readonly limit: LimitView }) {
  const now = useNow();
  const l = props.limit;
  const note = resetNote(l, now);
  const tick = l.other?.differs
    ? { left: l.other.left, title: `Second reading: ${SOURCE[l.other.kind]} ${percent(l.other.left)} left, ${age(now - l.other.at)} ago. The bar shows the ${SOURCE[l.source.kind]} reading.` }
    : null;
  const title = [
    note?.title,
    l.limiting && 'the limit holding this account back right now',
    `${SOURCE[l.source.kind]} ${age(now - l.source.at)} ago`,
    l.other && `${SOURCE[l.other.kind]} ${percent(l.other.left)} left ${age(now - l.other.at)} ago`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`cell limit phase-${l.phase} sev-${l.severity}`} data-testid={`limit-${l.key}`} title={title}>
      <span className="cell-label">{l.label}</span>
      <span className="cell-value num" data-testid="percent">
        <Left left={l.left} />
      </span>
      <span className="cell-note num">{note?.text}</span>
      <Meter left={l.left} severity={l.severity} label={`${l.label} left`} tick={tick} />
    </div>
  );
}

type Overage = NonNullable<SpendView['live']>;

const OVERAGE_STATUS: Readonly<Record<string, string>> = { allowed: 'allowed', allowed_warning: 'allowed, near the cap', rejected: 'rejected' };

const overageText = (o: Overage) =>
  [o.left !== null && `${percent(o.left)} left`, o.status && (OVERAGE_STATUS[o.status] ?? o.status), o.reason && `(${reasonText(o.reason)})`].filter(Boolean).join(' ');

interface SpendFace {
  readonly value: ReactNode;
  readonly note: string | null;
  readonly tone: 'quiet' | 'warning' | 'critical' | 'metered';
  readonly says: string;
}

function liveFace(o: Overage, now: number): SpendFace | null {
  const resets = o.resetsAt !== null && o.resetsAt > now ? `resets ${clockTime(o.resetsAt, now)}` : null;
  const why = o.reason ? reasonText(o.reason) : null;
  if (o.status === 'rejected') return { value: 'Cap reached', note: resets, tone: 'critical', says: [why ?? 'spend cap reached', 'extra-usage requests are rejected', resets].filter(Boolean).join('; ') };
  if (o.status === 'allowed_warning') return { value: 'Near cap', note: o.left === null ? resets : `${percent(o.left)} left`, tone: 'warning', says: 'near the spend cap; extra usage still allowed' };
  return null;
}

function spendFace(s: SpendView, atWall: boolean, now: number): SpendFace {
  const p = s.poll;
  const live = s.live !== null && s.live.severity !== 'normal' ? liveFace(s.live, now) : null;
  if (p?.state === 'off') return { value: 'Off', note: p.disabledReason ? reasonText(p.disabledReason) : null, tone: 'quiet', says: 'off; requests stop at the plan limits' };
  if (p?.state === 'no_budget') return { value: 'No budget', note: p.limit ? `${money(p.limit)} cap` : null, tone: 'quiet', says: 'on with a zero budget; requests stop at the plan limits' };
  if (p?.state === 'budget') {
    const note = p.limit && p.remaining ? `${money(p.remaining)} of ${money(p.limit)} left` : `${money(p.used)} spent`;
    return { value: <Left left={p.left} />, note, tone: 'metered', says: live?.says ?? (p.limit ? 'room left under the cap' : 'on, with no cap set') };
  }
  if (live) return live;
  return { value: 'Not read', note: atWall ? 'skipped at the limit' : null, tone: 'quiet', says: atWall ? 'amounts are not read while the account is at its limit' : 'not read yet' };
}

export function SpendCell(props: { readonly spend: SpendView | null; readonly atWall: boolean; readonly help: string }) {
  const now = useNow();
  const s = props.spend;
  if (!s) {
    return (
      <div className="cell spend" data-testid="spend" title={props.help}>
        <span className="cell-label">Extra usage</span>
        <span className="cell-value muted">—</span>
      </div>
    );
  }
  const face = spendFace(s, props.atWall, now);
  const p = s.poll;
  const codes = [...new Set([p?.disabledReason, s.live?.reason].filter(Boolean))];
  const title = [
    `Extra usage: ${face.says}`,
    p ? `poll ${age(now - p.at)} ago` : null,
    s.live && `${overageText(s.live)}, live ${age(now - s.live.at)} ago`,
    codes.length > 0 && `reason code: ${codes.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`cell spend tone-${face.tone}`} data-testid="spend" title={title}>
      <span className="cell-label">Extra usage</span>
      <span className="cell-value num">
        {face.tone === 'critical' && (
          <span className="cell-icon" aria-hidden>
            ✕
          </span>
        )}
        {face.value}
      </span>
      {face.note && <span className="cell-note num">{face.note}</span>}
      {p?.state === 'budget' && <Meter left={p.left} severity={s.live?.severity === 'critical' ? 'critical' : p.severity} label="Extra usage left" />}
    </div>
  );
}
