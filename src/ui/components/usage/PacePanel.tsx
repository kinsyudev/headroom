import type { ReactNode } from 'react';
import type { AccountId } from '../../../shared/domain';
import type { MeterTone, PaceView } from '../../../shared/view';
import { useNow } from '../../deck';
import { clockTime, compact, count, duration } from '../../format';
import { Meter } from '../LimitRow';

type Look = { readonly tone: MeterTone; readonly icon: string; readonly cls: string; readonly main: (p: PaceView, now: number) => ReactNode; readonly sub: (p: PaceView, now: number) => string };

/** What each outlook looks like. The icon and the words say it, and the colour only repeats it. */
const LOOKS: Readonly<Record<PaceView['pace']['outlook']['kind'], Look>> = {
  lasts: {
    tone: 'ample',
    icon: '✓',
    cls: 'ok',
    main: () => 'Lasts to the reset',
    sub: (p, now) => (p.pace.projected === null ? '' : `At this rate, ${Math.round(p.pace.projected)}% used by ${clockTime(p.pace.endsAt, now)}`),
  },
  hits: {
    tone: 'warning',
    icon: '!',
    cls: 'warn',
    main: (p, now) => {
      const o = p.pace.outlook;
      return o.kind === 'hits' ? `Runs out in ${duration(o.at - now)}` : null;
    },
    sub: (p, now) => {
      const o = p.pace.outlook;
      return o.kind === 'hits' ? `${duration(p.pace.endsAt - o.at)} before the reset at ${clockTime(p.pace.endsAt, now)}` : '';
    },
  },
  at_limit: { tone: 'critical', icon: '✕', cls: 'crit', main: () => 'At its limit', sub: (p, now) => `Resets ${clockTime(p.pace.endsAt, now)}, in ${duration(p.pace.endsAt - now)}` },
  too_early: { tone: 'ample', icon: '○', cls: 'quiet', main: () => 'Too early to say', sub: () => 'Under 5% of the window has passed' },
};

/** What the window has cost so far, and what one percent of it is worth. */
function spentTitle(p: PaceView): string {
  const s = p.spent;
  const per = p.perPercent;
  return [
    `${count(s.requests)} requests and ${compact(s.tokens.output)} output tokens on ${p.email.split('@')[0]} since the window opened`,
    per === null ? 'under 1% used, so too little to price one percent' : `1% of it is about ${count(per.requests)} requests or ${compact(per.output)} output tokens`,
  ].join('\n');
}

/**
 * Will each open quota window last until it resets, at the pace so far? A bullet bar per window: the fill is what is left, as on
 * the account cards, and the tick is where it would stand if the window were being used evenly. Short of the tick is running ahead.
 */
export function PacePanel(props: { readonly pace: readonly PaceView[]; readonly colors: ReadonlyMap<AccountId, string> }) {
  const now = useNow();
  const trouble = props.pace.filter((p) => p.pace.outlook.kind === 'hits' || p.pace.outlook.kind === 'at_limit');
  const headline = (() => {
    const hits = props.pace.filter((p) => p.pace.outlook.kind === 'hits');
    if (hits.length === 0) return trouble.length === 0 ? 'No window is on course to run out before it resets.' : 'Nothing else is on course to run out before it resets.';
    return hits
      .map((p) => {
        const o = p.pace.outlook;
        return o.kind === 'hits' ? `${p.email.split('@')[0]} ${p.limit.label.toLowerCase()} runs out in ${duration(o.at - now)}, before it resets at ${clockTime(p.pace.endsAt, now)}` : '';
      })
      .join(' · ');
  })();
  const warn = props.pace.some((p) => p.pace.outlook.kind === 'hits');

  return (
    <section className="card" aria-label="Quota pace" data-testid="pace">
      <div className="card-head">
        <div className="card-title">
          <h2>Quota pace</h2>
          <p>Will each quota window last until it resets, at the pace so far?</p>
        </div>
        <p className={`card-note pace-headline ${warn ? 'warn' : 'ok'}`} role="status">
          <span aria-hidden>{warn ? '!' : '✓'}</span> {headline}
        </p>
      </div>
      {props.pace.length === 0 ? (
        <p className="muted">No quota window is running. One opens with the next request.</p>
      ) : (
        <ul className="pace-list">
          {props.pace.map((p, i) => {
            const look = LOOKS[p.pace.outlook.kind];
            const first = i === 0 || props.pace[i - 1]!.account !== p.account;
            const left = Math.max(0, 100 - p.pace.used);
            const steady = 100 - p.pace.elapsed;
            return (
              <li key={`${p.account}:${p.limit.key}`} className={`pace-row ${first ? 'first' : ''}`}>
                <span className="pace-who">
                  {first && (
                    <>
                      <span className="swatch small" style={{ background: props.colors.get(p.account) }} aria-hidden />
                      <span className="pace-email" title={p.email}>
                        {p.email.split('@')[0]}
                      </span>
                    </>
                  )}
                </span>
                <span className="pace-window" title={spentTitle(p)}>
                  <strong>{p.limit.label}</strong>
                  <span className="muted num">
                    {Math.round(left)}% left · {Math.round(p.pace.elapsed)}% of the time gone
                  </span>
                </span>
                <span className="pace-bar">
                  <Meter left={left as never} tone={look.tone} label={`${p.limit.label} left on ${p.email}`} steady={steady} />
                </span>
                <span className={`pace-outlook ${look.cls}`}>
                  <span className="pace-icon" aria-hidden>
                    {look.icon}
                  </span>
                  <span>
                    <strong>{look.main(p, now)}</strong>
                    <span className="muted num">{look.sub(p, now)}</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="pace-key muted">
        <span className="meter-tick-key" aria-hidden /> Where the bar would stand if the window were used evenly. A fill short of the tick is ahead of pace.
      </p>
    </section>
  );
}
