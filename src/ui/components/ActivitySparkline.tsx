import { useState } from 'react';
import type { AccountView } from '../../shared/view';
import { useNow } from '../deck';
import { clockTime } from '../format';

const W = 240;
const H = 34;
const TEN_MIN = 600_000;

export function ActivitySparkline(props: { readonly buckets: AccountView['activity']; readonly color: string }) {
  const now = useNow();
  const [hover, setHover] = useState<number | null>(null);
  const b = props.buckets;
  if (b.length === 0) return null;
  const max = Math.max(1, ...b.map((x) => x.success + x.failed));
  const band = W / b.length;
  const bw = Math.min(8, band - 2);
  const total = b.reduce((n, x) => n + x.success + x.failed, 0);
  const h = hover === null ? null : b[hover]!;
  return (
    <figure className="spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${total} requests in the last ${b.length * 10} minutes`} onPointerLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="axis" />
        {b.map((x, i) => {
          const all = ((x.success + x.failed) / max) * (H - 3);
          const failed = (x.failed / max) * (H - 3);
          const left = i * band + (band - bw) / 2;
          return (
            <g key={x.start} onPointerEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.45}>
              <rect x={i * band} y={0} width={band} height={H} fill="transparent" />
              {all - failed > 0 && <rect x={left} y={H - 1 - all + failed} width={bw} height={all - failed} fill={props.color} rx={1.5} />}
              {failed > 0 && <rect x={left} y={H - 1 - all} width={bw} height={Math.max(failed, 1.5)} fill="var(--critical)" rx={1.5} />}
            </g>
          );
        })}
      </svg>
      <figcaption className="spark-caption">
        {h ? (
          <>
            <strong className="num">{h.success}</strong> ok
            {h.failed > 0 && (
              <>
                {' · '}
                <strong className="num">{h.failed}</strong> failed
              </>
            )}{' '}
            <span className="muted">
              {clockTime(h.start, now)}–{clockTime(h.start + TEN_MIN, now)}
            </span>
          </>
        ) : (
          <>
            <strong className="num">{total}</strong> requests in {Math.round((b.length * 10) / 60 * 10) / 10} h · per 10 min · from CPA
          </>
        )}
      </figcaption>
    </figure>
  );
}
