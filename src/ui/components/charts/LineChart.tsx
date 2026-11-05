import { memo, useRef, useState, type ReactNode } from 'react';
import { ChartTip } from './ChartTip';
import type { Bucket } from './StackedColumns';
import { niceTicks, tooltipLeft, useHeight, useWidth } from './kit';

export interface LineSeries {
  readonly key: string;
  readonly label: string;
  /** The short name drawn at the line's end. */
  readonly end: string;
  readonly color: string;
  /** A thinner, dashed line, so a second series is told from the first by more than its tone. */
  readonly dash?: boolean;
  /** null breaks the line: a bucket with too few samples to say. */
  readonly values: readonly (number | null)[];
}

const PAD = { top: 14, right: 92, bottom: 26, left: 48 };

export const LineChart = memo(function LineChart(props: {
  readonly buckets: readonly Bucket[];
  readonly series: readonly LineSeries[];
  readonly format: (n: number) => string;
  readonly axisFormat?: (n: number) => string;
  readonly bucketLabel: (bucket: Bucket) => string;
  readonly tooltipTitle: (bucket: Bucket) => string;
  readonly label: string;
  readonly extra?: (i: number) => ReactNode;
  readonly height?: number;
  /** Grow past `height` to fill the room the layout gives the chart, so a panel beside a taller one leaves no empty band. */
  readonly fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 400);
  const fill = props.fill === true;
  const measured = useHeight(ref, fill);
  const [hover, setHover] = useState<number | null>(null);
  const floor = Math.round((props.height ?? 190) * (width < 520 ? 0.85 : 1));
  const H = fill ? Math.max(floor, measured) : floor;
  const n = props.buckets.length;
  const plotW = Math.max(100, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(0, ...props.series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const ticks = niceTicks(max, 3);
  const yMax = ticks.at(-1)! || 1;
  const band = plotW / Math.max(1, n);
  const x = (i: number) => PAD.left + (i + 0.5) * band;
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(72 / band));
  const axis = props.axisFormat ?? props.format;

  const path = (values: readonly (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) pen = false;
      else {
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
    });
    return d;
  };
  const lastIndex = (values: readonly (number | null)[]) => values.findLastIndex((v) => v !== null);

  return (
    <div className={fill ? 'chart fill' : 'chart'} ref={ref} style={fill ? { minHeight: floor } : undefined} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={props.label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
              {axis(t)}
            </text>
          </g>
        ))}
        {props.buckets.map((b, i) => (i % labelEvery === 0 && (n - 1 - i) * band >= 36) || i === n - 1 ? (
          <text key={b.start} x={x(i)} y={H - 8} textAnchor="middle" className="tick">
            {props.bucketLabel(b)}
          </text>
        ) : null)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="crosshair" />}
        {props.series.map((s) => {
          const last = lastIndex(s.values);
          return (
            <g key={s.key}>
              <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.dash ? 1.5 : 2} strokeDasharray={s.dash ? '6 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
              {last >= 0 && hover === null && (
                <>
                  <circle cx={x(last)} cy={y(s.values[last]!)} r={4} fill={s.color} className="ring" />
                  <text x={x(last) + 10} y={y(s.values[last]!)} dy="0.32em" className="tick end-label">
                    {s.end}
                  </text>
                </>
              )}
              {hover !== null && s.values[hover] != null && <circle cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} className="ring" />}
            </g>
          );
        })}
        {props.buckets.map((b, i) => (
          <rect
            key={b.start}
            x={PAD.left + i * band}
            y={PAD.top}
            width={band}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${props.tooltipTitle(b)}: ${props.series.map((s) => `${s.label} ${s.values[i] == null ? 'no reading' : props.format(s.values[i]!)}`).join(', ')}`}
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {hover !== null && props.buckets[hover] && (
        <ChartTip
          left={tooltipLeft(PAD.left + hover * band, band, PAD.left + plotW, 220)}
          width={220}
          title={props.tooltipTitle(props.buckets[hover])}
          rows={props.series.map((s) => ({ key: s.key, color: s.color, mark: s.dash ? 'dash' : 'line', value: s.values[hover] == null ? '—' : props.format(s.values[hover]!), label: s.label }))}
        >
          {props.extra?.(hover)}
        </ChartTip>
      )}
    </div>
  );
});
