import { memo, useRef, useState, type ReactNode } from 'react';
import { ChartTip } from './ChartTip';
import { niceTicks, roundedTop, tooltipLeft, useWidth } from './kit';

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

const PAD = { top: 14, right: 8, bottom: 26, left: 48 };
const GAP = 2;
const NOW_LABEL_CLEARANCE = 40;

/** A fixed vertical scale, for a chart whose total is the whole (a share that adds to 100%). */
export interface Domain {
  readonly max: number;
  readonly ticks: readonly number[];
}

export const StackedColumns = memo(function StackedColumns(props: {
  readonly buckets: readonly Bucket[];
  readonly series: readonly Series[];
  readonly format: (n: number) => string;
  readonly bucketLabel: (bucket: Bucket) => string;
  readonly tooltipTitle: (bucket: Bucket) => string;
  readonly label: string;
  readonly extra?: (i: number) => ReactNode;
  readonly dim?: boolean;
  readonly height?: number;
  readonly domain?: Domain;
  /** Names the top of a fixed scale, such as the 100% a share can reach: drawn as a brighter hairline with its label. */
  readonly ceiling?: string;
  readonly hideTotal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState<number | null>(null);
  const H = Math.round((props.height ?? 230) * (width < 600 ? 0.82 : 1));
  const n = props.buckets.length;
  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const totals = props.buckets.map((_, i) => props.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const ticks = props.domain?.ticks ?? niceTicks(Math.max(...totals, 0));
  const yMax = props.domain?.max ?? (ticks.at(-1)! || 1);
  const band = plotW / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band - 4));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(64 / band));
  const nowAt = props.buckets.findIndex((b) => b.partial);
  const labelled = (b: Bucket, i: number) => b.partial || (i % labelEvery === 0 && (nowAt < 0 || (nowAt - i) * band >= NOW_LABEL_CLEARANCE));

  return (
    <div className={`chart ${props.dim ? 'dim' : ''}`} ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={props.label}>
        <defs>
          <pattern id="partial-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="hatch" width="2.5" height="6" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : props.ceiling && t === yMax ? 'ceiling' : 'grid'} />
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
            k === segs.length - 1 ? <path d={roundedTop(x, g.top, bw, g.bottom - g.top)} fill={fill} /> : <rect x={x} y={g.top} width={bw} height={g.bottom - g.top} fill={fill} />;
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
        {props.ceiling && (
          <text x={PAD.left + plotW} y={y(yMax) - 4} textAnchor="end" className="tick ceiling-label">
            {props.ceiling}
          </text>
        )}
      </svg>
      {hover !== null && props.buckets[hover] && (
        <ChartTip
          left={tooltipLeft(PAD.left + hover * band, band, PAD.left + plotW)}
          title={props.tooltipTitle(props.buckets[hover])}
          rows={props.series.filter((s) => (s.values[hover] ?? 0) > 0).map((s) => ({ key: s.key, color: s.color, value: props.format(s.values[hover] ?? 0), label: s.label }))}
          total={props.hideTotal ? undefined : { value: props.format(totals[hover] ?? 0), label: 'total' }}
        >
          {props.extra?.(hover)}
        </ChartTip>
      )}
    </div>
  );
});
