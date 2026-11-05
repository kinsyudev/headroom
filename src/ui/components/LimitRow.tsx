import type { ReactNode } from 'react';
import type { PercentLeft } from '../../shared/domain';
import type { LimitView, MeterTone, SpendView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, duration, leftLabel, money, percent, reasonText } from '../format';

const SOURCE: Readonly<Record<'poll' | 'headers', string>> = { poll: 'poll', headers: 'live' };

/** steady: where the fill would end if the window were being used evenly, so a fill that stops short of the tick is running ahead of pace. */
export function Meter(props: {
  readonly left: PercentLeft | null;
  readonly tone: MeterTone;
  readonly label: string;
  readonly steady?: number | null;
}) {
  return (
    <div className={`meter tone-${props.tone}`} role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.left ?? undefined}>
      {props.left !== null && props.left > 0 && <div className="meter-fill" style={{ width: `${props.left}%` }} />}
      {props.steady != null && <div className="meter-tick" style={{ left: `${props.steady}%` }} aria-hidden />}
    </div>
  );
}

/** What the steady-pace tick on the meter means, said in words for the cell's tooltip. */
function paceTitle(p: NonNullable<LimitView['pace']>, now: number): string {
  const even = `${Math.round(100 - p.elapsed)}% left would be an even pace by now`;
  switch (p.outlook.kind) {
    case 'hits':
      return `${even}; at this rate it runs out in ${duration(p.outlook.at - now)}, before the reset`;
    case 'lasts':
      return `${even}; at this rate it lasts to the reset`;
    case 'at_limit':
      return 'no room left in this window';
    case 'too_early':
      return `${even}; too early in the window to project`;
  }
}

function resetNote(l: LimitView, now: number): { readonly text: string; readonly title: string } | null {
  if (l.phase === 'idle') return { text: 'starts on first request', title: 'No session window is running, so all of it is left; one starts with the next request' };
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
  const pace = l.pace;
  const runsOut = pace?.outlook.kind === 'hits' ? pace.outlook : null;
  const title = [
    note?.title,
    pace && paceTitle(pace, now),
    l.limiting && 'the limit holding this account back right now',
    `${SOURCE[l.source.kind]} ${age(now - l.source.at)} ago`,
    l.other && `Second reading: ${SOURCE[l.other.kind]} ${percent(l.other.left)} left, ${age(now - l.other.at)} ago`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`cell limit phase-${l.phase} sev-${l.severity}`} data-testid={`limit-${l.key}`} title={title}>
      <span className="cell-label">{leftLabel(l.label)}</span>
      <span className="cell-value num" data-testid="percent">
        {percent(l.left)}
      </span>
      <span className="cell-note num">{note?.text}</span>
      <Meter left={l.left} tone={l.tone} label={leftLabel(l.label)} steady={pace === null ? null : 100 - pace.elapsed} />
      {runsOut && pace && (
        <span className="cell-pace num" data-testid="pace-note">
          <span aria-hidden>! </span>Runs out in {duration(runsOut.at - now)}
        </span>
      )}
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

const resetsText = (o: Overage | null, now: number) => (o?.resetsAt && o.resetsAt > now ? `resets ${clockTime(o.resetsAt, now)}` : null);

function liveFace(o: Overage, now: number): SpendFace | null {
  const resets = resetsText(o, now);
  const why = o.reason ? reasonText(o.reason) : null;
  if (o.status === 'rejected') return { value: 'Cap reached', note: resets, tone: 'critical', says: [why ?? 'spend cap reached', 'extra-usage requests are rejected', resets].filter(Boolean).join('; ') };
  if (o.status === 'allowed_warning') return { value: 'Near cap', note: o.left === null ? resets : `${percent(o.left)} left`, tone: 'warning', says: 'near the spend cap; extra usage still allowed' };
  return null;
}

function spendFace(s: SpendView, atWall: boolean, now: number): SpendFace {
  const p = s.poll;
  const live = s.live !== null && s.live.severity !== 'normal' ? liveFace(s.live, now) : null;
  if (p?.state === 'off') return { value: 'Off', note: p.disabledReason ? reasonText(p.disabledReason) : null, tone: 'quiet', says: 'off; requests stop at the plan limits' };
  if (p?.state === 'no_budget') return { value: 'Off', note: null, tone: 'quiet', says: 'off, with a zero budget set; requests stop at the plan limits' };
  if (p?.state === 'cap_used') {
    const says = ['the monthly extra-usage cap is used up, so extra-usage requests are rejected until it resets', resetsText(s.live, now)];
    return { value: 'Cap used', note: p.limit && `${money(p.used)} of ${money(p.limit)}`, tone: 'critical', says: says.filter(Boolean).join('; ') };
  }
  if (p?.state === 'budget') {
    const note = p.limit && p.remaining ? `${money(p.remaining)} of ${money(p.limit)} left` : `${money(p.used)} spent`;
    return { value: percent(p.left), note, tone: 'metered', says: live?.says ?? (p.limit ? 'room left under the cap' : 'on, with no cap set') };
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
      {(p?.state === 'budget' || p?.state === 'cap_used') && <Meter left={p.left} tone={p.tone} label="Extra usage left" />}
    </div>
  );
}
