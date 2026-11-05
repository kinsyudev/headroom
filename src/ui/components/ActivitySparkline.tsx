import { useState } from 'react';
import type { AccountView } from '../../shared/view';
import { useNow } from '../deck';
import { clockTime, duration } from '../format';

const W = 240;
const H = 22;
const TICK = 3;
const TEN_MIN = 600_000;

/** How far back an account's request bars reach: "3h 20m". */
export const activitySpan = (buckets: AccountView['activity']): string => duration(buckets.length * TEN_MIN);

export function ActivityCell(props: { readonly buckets: AccountView['activity']; readonly color: string; readonly help: string }) {
  const now = useNow();
  const [hover, setHover] = useState<number | null>(null);
  const b = props.buckets;
  if (b.length === 0) {
    return (
      <div className="cell activity" title={props.help}>
        <span className="cell-label">Requests</span>
        <span className="cell-value muted">—</span>
      </div>
    );
  }
  const max = Math.max(1, ...b.map((x) => x.success + x.failed));
  const band = W / b.length;
  const bw = Math.max(2, band - 2);
  const total = b.reduce((n, x) => n + x.success + x.failed, 0);
  const failed = b.reduce((n, x) => n + x.failed, 0);
  const since = clockTime(b[0]!.start, now);
  const span = activitySpan(b);
  const h = hover === null ? null : b[hover]!;
  return (
    <figure className="cell activity" title={`${props.help} The bars start at ${since}. A red tick under a bar marks failed requests.`}>
      <span className="cell-label">Requests</span>
      <figcaption className="cell-value num">
        {h ? (
          <>
            {h.success + h.failed}
            <span className="cell-unit">
              {h.failed > 0 && <> · {h.failed} failed</>} {clockTime(h.start, now)}–{clockTime(h.start + TEN_MIN, now)}
            </span>
          </>
        ) : (
          <>
            {total}
            <span className="cell-unit cell-span"> in the last {span}</span>
          </>
        )}
        {failed > 0 && (
          <span className="cell-fail">
            <span className="fail-key" aria-hidden /> {failed} failed
          </span>
        )}
      </figcaption>
      <svg className="spark" viewBox={`0 0 ${W} ${H + TICK + 2}`} preserveAspectRatio="none" role="img" aria-label={`${total} requests in the last ${span}, ${failed} failed`} onPointerLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="axis" />
        {b.map((x, i) => {
          const n = x.success + x.failed;
          const tall = n === 0 ? 0 : Math.max(2.5, (n / max) * (H - 2));
          const left = i * band + (band - bw) / 2;
          return (
            <g key={x.start} onPointerEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.45}>
              <rect x={i * band} y={0} width={band} height={H + TICK + 2} fill="transparent" />
              {n === 0 ? <rect x={left} y={H - 3} width={bw} height={2} className="slot" /> : <rect x={left} y={H - 1 - tall} width={bw} height={tall} fill={props.color} rx={1} />}
              {x.failed > 0 && <rect x={left} y={H + 1} width={bw} height={TICK} className="failed-tick" rx={1} />}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
