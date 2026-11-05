import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: readonly number[];
}

export interface Bucket {
  readonly start: number;
  readonly end: number;
  readonly partial: boolean;
}

const H = 230;
const PAD = { top: 14, right: 8, bottom: 26, left: 48 };
const GAP = 2;
const NOW_LABEL_CLEARANCE = 40;

export function StackedColumns(props: {
  readonly buckets: readonly Bucket[];
  readonly series: readonly Series[];
  readonly format: (n: number) => string;
  readonly bucketLabel: (bucket: Bucket) => string;
  readonly tooltipTitle: (bucket: Bucket) => string;
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
  const nowAt = props.buckets.findIndex((b) => b.partial);
  const labelled = (b: Bucket, i: number) => b.partial || (i % labelEvery === 0 && (nowAt < 0 || (nowAt - i) * band >= NOW_LABEL_CLEARANCE));

  return (
    <div className={`chart ${props.dim ? 'dim' : ''}`} ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label="Stacked usage per account">
        <defs>
          <pattern id="partial-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="hatch" width="2.5" height="6" />
          </pattern>
        </defs>
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
          const shape = (g: { top: number; bottom: number }, k: number, fill: string) =>
            k === segs.length - 1 ? (
              <path d={roundedTop(x, g.top, bw, g.bottom - g.top)} fill={fill} />
            ) : (
              <rect x={x} y={g.top} width={bw} height={g.bottom - g.top} fill={fill} />
            );
          return (
            <g key={b.start}>
              <g opacity={hover === null || hover === i ? 1 : 0.55}>
                {segs.map((g, k) => (
                  <g key={g.key}>
                    {shape(g, k, g.color)}
                    {b.partial && shape(g, k, 'url(#partial-hatch)')}
                  </g>
                ))}
              </g>
              {labelled(b, i) && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="tick">
                  {props.bucketLabel(b)}
                </text>
              )}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${props.tooltipTitle(b)}: ${props.format(totals[i] ?? 0)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && props.buckets[hover] && (
        <div className="tooltip" style={{ left: tooltipLeft(PAD.left + hover * band, band, PAD.left + plotW) }}>
          <div className="tooltip-title">{props.tooltipTitle(props.buckets[hover])}</div>
          {props.series
            .filter((s) => (s.values[hover] ?? 0) > 0)
            .map((s) => (
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

const TOOLTIP_W = 210;

function tooltipLeft(columnX: number, band: number, plotRight: number): number {
  return columnX + band / 2 < plotRight / 2 ? columnX + band + 8 : Math.max(0, columnX - TOOLTIP_W - 8);
}

function roundedTop(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const bottom = top + h;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
}

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
