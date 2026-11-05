import type { ReactNode } from 'react';
import type { AccountId } from '../../../shared/domain';
import type { MeterTone, PaceAccountView, PaceView } from '../../../shared/view';
import { useNow } from '../../deck';
import { clockTime, compact, count, duration, foldedPaceSays, PACE_TICK_HELP, runOutWhen, shortName } from '../../format';
import { paceAnchor, useJumpTarget } from '../../route';
import { Meter } from '../LimitRow';
import { Swatch, type Slot } from '../Swatch';

type Look = { readonly tone: MeterTone; readonly icon: string; readonly cls: string; readonly main: (p: PaceView, now: number) => ReactNode; readonly sub: (p: PaceView, now: number) => string };

/** What each outlook looks like. The icon and the words say it, and the colour only repeats it. */
const LOOKS: Readonly<Record<PaceView['pace']['outlook']['kind'], Look>> = {
  lasts: {
    tone: 'normal',
    icon: '✓',
    cls: 'ok',
    main: () => 'Lasts to the reset',
    sub: (p, now) => (p.pace.projected === null ? '' : `About ${Math.round(Math.max(0, 100 - p.pace.projected))}% left at the reset · ${clockTime(p.pace.endsAt, now)}`),
  },
  hits: {
    tone: 'warning',
    icon: '!',
    cls: 'warn',
    main: (p, now) => {
      const o = p.pace.outlook;
      return o.kind === 'hits' ? `Runs out ${runOutWhen(o.at, now)}` : null;
    },
    sub: (p, now) => {
      const o = p.pace.outlook;
      return o.kind === 'hits' ? `${duration(p.pace.endsAt - o.at)} before the reset at ${clockTime(p.pace.endsAt, now)}` : '';
    },
  },
  at_limit: { tone: 'critical', icon: '✕', cls: 'crit', main: () => 'At its limit', sub: (p, now) => `Resets ${clockTime(p.pace.endsAt, now)}, in ${duration(p.pace.endsAt - now)}` },
  too_early: { tone: 'normal', icon: '○', cls: 'quiet', main: () => 'Too early to say', sub: () => 'Under 5% of the window has passed' },
};

/** What the window has cost so far, and what one percent of it is worth. */
function spentTitle(p: PaceView): string {
  const s = p.spent;
  const per = p.perPercent;
  return [
    `${count(s.requests)} requests and ${compact(s.tokens.output)} output tokens on ${shortName(p.email)} since the window opened`,
    per === null ? 'under 1% used, so too little to price one percent' : `1% of it is about ${count(per.requests)} requests or ${compact(per.output)} output tokens`,
  ].join('\n');
}

function Who(props: { readonly account: PaceAccountView; readonly slot: Slot | undefined }) {
  return (
    <>
      <Swatch slot={props.slot} />
      <span className="pace-email" title={props.account.email}>
        {shortName(props.account.email)}
      </span>
    </>
  );
}

function PaceRow(props: { readonly p: PaceView; readonly who: ReactNode; readonly target: string | null; readonly now: number }) {
  const { p, now } = props;
  const look = LOOKS[p.pace.outlook.kind];
  const left = Math.max(0, 100 - p.pace.used);
  const id = paceAnchor(p.account, p.limit.key);
  return (
    <li id={id} tabIndex={-1} className={`pace-row ${props.target === id ? 'targeted' : ''}`}>
      <span className="pace-who">{props.who}</span>
      <span className="pace-window" title={spentTitle(p)}>
        <strong>{p.limit.label}</strong>
        <span className="muted num">
          {Math.round(left)}% left · {Math.round(p.pace.elapsed)}% of the time gone
        </span>
      </span>
      <span className="pace-bar">
        <Meter left={left as never} tone={look.tone} label={`${p.limit.label} left on ${p.email}`} steady={100 - p.pace.elapsed} />
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
}

/** The windows that last or are too early, as one line that keeps each one's percent left and reset time, and opens to their bars. */
function PaceFold(props: { readonly account: PaceAccountView; readonly who: ReactNode; readonly target: string | null; readonly now: number }) {
  const { account, now } = props;
  const lasts = account.steady.filter((p) => p.pace.outlook.kind === 'lasts').length;
  const look = lasts > 0 ? LOOKS.lasts : LOOKS.too_early;
  const holdsTarget = account.steady.some((p) => paceAnchor(p.account, p.limit.key) === props.target);
  return (
    <details className="pace-fold" open={holdsTarget}>
      <summary className="pace-sum">
        <span className="pace-who">
          {props.who ?? <span className="sr-only">{shortName(account.email)}</span>}
        </span>
        <span className="pace-chips">
          {account.steady.map((p) => (
            <span key={p.limit.key} className="pace-chip" title={spentTitle(p)}>
              <strong>{p.limit.label}</strong> <span className="num">{Math.round(Math.max(0, 100 - p.pace.used))}% left</span>{' '}
              <span className="muted num">resets {clockTime(p.pace.endsAt, now)}</span>
            </span>
          ))}
        </span>
        <span className={`pace-outlook ${look.cls}`}>
          <span className="pace-icon" aria-hidden>
            {look.icon}
          </span>
          <span>
            <strong>{foldedPaceSays(lasts, account.steady.length - lasts)}</strong>
          </span>
          <span className="pace-toggle" aria-hidden>
            <span className="when-closed">Show bars</span>
            <span className="when-open">Hide bars</span>
            <span className="pace-chevron" />
          </span>
        </span>
      </summary>
      <ul className="pace-rows">
        {account.steady.map((p) => (
          <PaceRow key={p.limit.key} p={p} who={null} target={props.target} now={now} />
        ))}
      </ul>
    </details>
  );
}

/**
 * Will each open quota window last until it resets, at the pace so far? A window that runs out or sits at its limit gets a bullet bar:
 * the fill is what is left, as on the account cards, and the tick is where it would stand if the window were being used evenly. The
 * windows that last fold into one line per account, so a healthy account costs one line and the page opens on what needs a look. It
 * reads the quota windows, not the range or the filters, so it leads the view and the Explore bar sits below it.
 */
export function PacePanel(props: { readonly pace: readonly PaceAccountView[]; readonly slots: ReadonlyMap<AccountId, Slot> }) {
  const now = useNow();
  const target = useJumpTarget();
  const attention = props.pace.flatMap((a) => a.attention);
  const anyHits = attention.some((p) => p.pace.outlook.kind === 'hits');

  return (
    <section className="card" aria-label="Quota pace" data-testid="pace">
      <div className="card-head">
        <div className="card-title">
          <h2>Quota pace</h2>
          <p>Will each quota window last until it resets, at the pace so far?</p>
        </div>
        {!anyHits && (
          <p className="card-note pace-headline" role="status">
            <span aria-hidden>✓</span> {attention.length === 0 ? 'No window is on course to run out before it resets.' : 'Nothing else is on course to run out before it resets.'}
          </p>
        )}
      </div>
      {props.pace.length === 0 ? (
        <p className="muted">No quota window is running. One opens with the next request.</p>
      ) : (
        <ul className="pace-list">
          {props.pace.map((a) => {
            const who = <Who account={a} slot={props.slots.get(a.account)} />;
            return (
              <li key={a.account} className="pace-account">
                {a.attention.length > 0 && (
                  <ul className="pace-rows">
                    {a.attention.map((p, i) => (
                      <PaceRow key={p.limit.key} p={p} who={i === 0 ? who : null} target={target} now={now} />
                    ))}
                  </ul>
                )}
                {a.steady.length > 0 && <PaceFold account={a} who={a.attention.length === 0 ? who : null} target={target} now={now} />}
              </li>
            );
          })}
        </ul>
      )}
      <p className="pace-key muted">
        <span className="meter-tick-key" aria-hidden /> {PACE_TICK_HELP}
      </p>
    </section>
  );
}
