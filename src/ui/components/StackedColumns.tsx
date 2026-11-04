/**
 * Stacked columns in plain SVG, one segment per account. Marks follow the dataviz specs: columns
 * at most 24px wide, a 2px surface gap between segments, a 4px rounded top, hairline solid grid,
 * compact ticks. Each column is its own hover target and lists every series, values first.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: readonly number[];
}

const H = 230;
const PAD = { top: 14, right: 8, bottom: 26, left: 48 };
const GAP = 2;

export function StackedColumns(props: {
  readonly buckets: readonly { readonly start: number; readonly end: number }[];
  readonly series: readonly Series[];
  readonly format: (n: number) => string;
  readonly bucketLabel: (start: number, i: number) => string;
  readonly tooltipTitle: (start: number, end: number) => string;
  readonly extra?: (i: number) => ReactNode;
  readonly dim?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState<number | null>(null);
  const n = props.buckets.length;
  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const totals = props.buckets.map((_, i) => props.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const yMax = ticks.at(-1)! || 1;
  const band = plotW / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band - 4));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(64 / band));

  return (
    <div className={`chart ${props.dim ? 'dim' : ''}`} ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label="Stacked usage per account">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
              {props.format(t)}
            </text>
          </g>
        ))}
        {props.buckets.map((b, i) => {
          const x = PAD.left + i * band + (band - bw) / 2;
          let acc = 0;
          const segs = props.series.flatMap((s, si) => {
            const v = s.values[i] ?? 0;
            if (v <= 0) return [];
            const bottom = y(acc) - (acc > 0 ? GAP : 0);
            acc += v;
            const top = y(acc);
            return bottom - top > 0.5 ? [{ key: s.key, color: s.color, top, bottom, si }] : [];
          });
          return (
            <g key={b.start} opacity={hover === null || hover === i ? 1 : 0.55}>
              {segs.map((g, k) =>
                k === segs.length - 1 ? (
                  <path key={g.key} d={roundedTop(x, g.top, bw, g.bottom - g.top)} fill={g.color} />
                ) : (
                  <rect key={g.key} x={x} y={g.top} width={bw} height={g.bottom - g.top} fill={g.color} />
                ),
              )}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="tick">
                  {props.bucketLabel(b.start, i)}
                </text>
              )}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${props.tooltipTitle(b.start, b.end)}: ${props.format(totals[i] ?? 0)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && props.buckets[hover] && (
        <div className="tooltip" style={{ left: Math.min(width - 210, Math.max(0, PAD.left + hover * band + band / 2 - 100)) }}>
          <div className="tooltip-title">{props.tooltipTitle(props.buckets[hover].start, props.buckets[hover].end)}</div>
          {props.series.map((s) => (
            <div key={s.key} className="tooltip-row">
              <span className="line-key" style={{ background: s.color }} />
              <strong className="num">{props.format(s.values[hover] ?? 0)}</strong>
              <span className="muted">{s.label}</span>
            </div>
          ))}
          <div className="tooltip-row total">
            <strong className="num">{props.format(totals[hover] ?? 0)}</strong>
            <span className="muted">total</span>
          </div>
          {props.extra?.(hover)}
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const bottom = top + h;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
}

/** 0 plus 3-5 round steps of 1, 2 or 5 times a power of ten. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = 0; t < max + step; t += step) ticks.push(t);
  return ticks;
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
