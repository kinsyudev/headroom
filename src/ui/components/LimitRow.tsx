import type { CSSProperties } from 'react';
import type { Severity } from '../../shared/domain';
import type { LimitView, SpendView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, duration, money, percent, reasonText } from '../format';

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

function resetNote(l: LimitView, now: number): { readonly text: string; readonly title: string } | null {
  if (l.phase === 'idle') return { text: 'no window running', title: 'No session window is running; one starts with the next request' };
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
  const title = [
    note?.title,
    l.limiting && 'the limit holding this account back right now',
    `${SOURCE[l.source.kind]} ${age(now - l.source.at)} ago`,
    l.other && `${SOURCE[l.other.kind]} ${percent(l.other.percent)} ${age(now - l.other.at)} ago`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`cell limit phase-${l.phase} sev-${l.severity}`} data-testid={`limit-${l.key}`} title={title}>
      <span className="cell-label">{l.label}</span>
      <span className="cell-value num" data-testid="percent">
        {l.phase === 'open' ? percent(l.percent) : l.phase === 'idle' ? 'idle' : '—'}
      </span>
      <span className="cell-note num">{note?.text}</span>
      <Meter percent={l.phase === 'open' ? l.percent : null} severity={l.severity} label={`${l.label} used`} tick={l.other?.percent ?? null} />
    </div>
  );
}

type Overage = NonNullable<SpendView['live']>;

const OVERAGE_STATUS: Readonly<Record<string, string>> = { allowed: 'allowed', allowed_warning: 'allowed, near the cap', rejected: 'rejected' };

const overageText = (o: Overage) =>
  [o.percent !== null && percent(o.percent), o.status && (OVERAGE_STATUS[o.status] ?? o.status), o.reason && `(${reasonText(o.reason)})`].filter(Boolean).join(' ');

interface SpendFace {
  readonly value: string;
  readonly note: string | null;
  readonly tone: 'quiet' | 'warning' | 'critical' | 'metered';
  readonly says: string;
}

function liveFace(o: Overage, now: number): SpendFace | null {
  const resets = o.resetsAt !== null && o.resetsAt > now ? `resets ${clockTime(o.resetsAt, now)}` : null;
  const why = o.reason ? reasonText(o.reason) : null;
  if (o.status === 'rejected') return { value: 'Cap reached', note: resets, tone: 'critical', says: [why ?? 'spend cap reached', 'extra-usage requests are rejected', resets].filter(Boolean).join('; ') };
  if (o.status === 'allowed_warning') return { value: 'Near cap', note: o.percent === null ? resets : percent(o.percent), tone: 'warning', says: 'near the spend cap; extra usage still allowed' };
  return null;
}

function spendFace(s: SpendView, atWall: boolean, now: number): SpendFace {
  const p = s.poll;
  const live = s.live !== null && s.live.severity !== 'normal' ? liveFace(s.live, now) : null;
  if (p?.state === 'off') return { value: 'Off', note: p.disabledReason ? reasonText(p.disabledReason) : null, tone: 'quiet', says: 'off; requests stop at the plan limits' };
  if (p?.state === 'no_budget') return { value: 'No budget', note: p.limit ? `${money(p.limit)} cap` : null, tone: 'quiet', says: 'on with a zero budget; requests stop at the plan limits' };
  if (p?.state === 'budget') return { value: percent(p.percent), note: p.limit ? `${money(p.used)} of ${money(p.limit)}` : `${money(p.used)} spent`, tone: 'metered', says: live?.says ?? 'spent of the budget' };
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
      {p?.state === 'budget' && <Meter percent={p.percent} severity={s.live?.severity === 'critical' ? 'critical' : p.severity} label="Extra usage spent" />}
    </div>
  );
}
