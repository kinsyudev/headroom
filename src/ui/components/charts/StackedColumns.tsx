import { memo, useRef, useState, type ReactNode } from 'react';
import { changeText } from '../../format';
import { ChartTip } from './ChartTip';
import { Key } from './Key';
import { TOOLTIP_W, niceTicks, roundedTop, tooltipLeft, useHeight, useWidth } from './kit';

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
const LEVEL_OVERHANG = 5;
const LEVEL_THICKNESS = 2;

/** One neutral for what a column is compared with, so the mark on the chart, the legend key and the tooltip row are the same line. */
export const PREVIOUS_COLOR = 'var(--muted)';

/** A fixed vertical scale from zero, for a chart whose values are shares and not counts. */
export interface Domain {
  readonly max: number;
  readonly ticks: readonly number[];
}

/** The same buckets one span earlier, drawn as a thin level across each column at its earlier value, on the chart's one scale. null leaves a column without. */
export interface Previous {
  readonly label: (bucket: Bucket) => string;
  readonly values: readonly (number | null)[];
}

const PREVIOUS_TIP_W = 290;

/** How a bucket stands against its earlier self, as the end of a tooltip row: " · ▲ 12%". Nothing when the earlier one was zero. */
function versus(now: number, before: number): string {
  if (before === 0) return '';
  const change = (now - before) / before;
  return Math.abs(change) < 0.005 ? ' · no change' : ` · ${change > 0 ? '▲' : '▼'} ${changeText(change)}`;
}

export const StackedColumns = memo(function StackedColumns(props: {
  readonly buckets: readonly Bucket[];
  readonly series: readonly Series[];
  readonly format: (n: number) => string;
  /** How the axis writes a tick, where it should differ from a value, such as one decimal on every tick or none. */
  readonly tickFormat?: (n: number) => string;
  readonly bucketLabel: (bucket: Bucket) => string;
  readonly tooltipTitle: (bucket: Bucket) => string;
  readonly label: string;
  readonly extra?: (i: number) => ReactNode;
  readonly dim?: boolean;
  readonly height?: number;
  readonly domain?: Domain;
  readonly hideTotal?: boolean;
  readonly previous?: Previous | undefined;
  /** Grow past `height` to fill the room the layout gives the chart, so a panel beside a taller one leaves no empty band. */
  readonly fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const fill = props.fill === true;
  const measured = useHeight(ref, fill);
  const [hover, setHover] = useState<number | null>(null);
  const floor = Math.round((props.height ?? 230) * (width < 600 ? 0.82 : 1));
  const H = fill ? Math.max(floor, measured) : floor;
  const n = props.buckets.length;
  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const totals = props.buckets.map((_, i) => props.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const prev = props.previous?.values ?? [];
  const ticks = props.domain?.ticks ?? niceTicks(Math.max(...totals, ...prev.map((p) => p ?? 0), 0));
  const tipW = props.previous ? PREVIOUS_TIP_W : TOOLTIP_W;
  const yMax = props.domain?.max ?? (ticks.at(-1)! || 1);
  const band = plotW / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, band - 4));
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(64 / band));
  const nowAt = props.buckets.findIndex((b) => b.partial);
  const labelled = (b: Bucket, i: number) => b.partial || (i % labelEvery === 0 && (nowAt < 0 || (nowAt - i) * band >= NOW_LABEL_CLEARANCE));

  return (
    <div className={`chart ${props.dim ? 'dim' : ''} ${fill ? 'fill' : ''}`} ref={ref} style={fill ? { minHeight: floor } : undefined} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={props.label}>
        <defs>
          <pattern id="partial-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="hatch" width="2.5" height="6" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
              {(props.tickFormat ?? props.format)(t)}
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
          const p = prev[i];
          return (
            <g key={b.start}>
              <g opacity={hover === null || hover === i ? 1 : 0.55}>
                {segs.map((g, k) => (
                  <g key={g.key}>
                    {shape(g, k, g.color)}
                    {b.partial && shape(g, k, 'url(#partial-hatch)')}
                  </g>
                ))}
                {p != null && <rect className="prev-level" x={x - LEVEL_OVERHANG} y={y(p) - LEVEL_THICKNESS / 2} width={bw + 2 * LEVEL_OVERHANG} height={LEVEL_THICKNESS} rx={1} fill={PREVIOUS_COLOR} />}
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
                aria-label={`${props.tooltipTitle(b)}: ${props.format(totals[i] ?? 0)}${props.previous && p != null ? `, ${props.previous.label(b).toLowerCase()} ${props.format(p)}` : ''}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && props.buckets[hover] && (
        <ChartTip
          left={tooltipLeft(PAD.left + hover * band, band, PAD.left + plotW, tipW)}
          width={tipW}
          title={props.tooltipTitle(props.buckets[hover])}
          rows={props.series.filter((s) => (s.values[hover] ?? 0) > 0).map((s) => ({ key: s.key, color: s.color, value: props.format(s.values[hover] ?? 0), label: s.label }))}
          total={props.hideTotal ? undefined : { value: props.format(totals[hover] ?? 0), label: 'total' }}
        >
          {props.previous && prev[hover] != null && (
            <div className="tooltip-row">
              <Key mark="line" color={PREVIOUS_COLOR} />
              <strong className="num">{props.format(prev[hover])}</strong>
              <span className="muted">
                {props.previous.label(props.buckets[hover])}
                {versus(totals[hover] ?? 0, prev[hover])}
              </span>
            </div>
          )}
          {props.extra?.(hover)}
        </ChartTip>
      )}
    </div>
  );
});
