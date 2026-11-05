import { memo, useRef, useState } from 'react';
import type { WeekGrid } from '../../../shared/view';
import { count, hourText, weekdayName } from '../../format';
import { ChartTip } from './ChartTip';
import { useWidth } from './kit';

/** The brand ramp, faintest to brightest. Equal-width steps from zero to the busiest slot, so a darker cell is more and never different. */
const RAMP = ['var(--ice-1)', 'var(--ice-2)', 'var(--ice-3)', 'var(--ice-4)', 'var(--ice-5)', 'var(--ice-6)'] as const;
const STEPS = RAMP.length;

const PAD = { left: 40, top: 30, bottom: 4 };
const ROW_H = 32;
const GAP = 3;
const MARGINAL_W = 132;
const TIP_W = 220;

const mean = (c: WeekGrid['rows'][number][number]) => (c.occurrences === 0 ? 0 : c.stats.requests / c.occurrences);

export const stepOf = (value: number, max: number): number => (value <= 0 || max <= 0 ? -1 : Math.min(STEPS - 1, Math.floor((value / max) * STEPS)));

/** Weekday by hour of day. Each cell is the mean requests in that hour on that weekday; the bars at the right are the average day. */
export const Heatmap = memo(function Heatmap(props: { readonly grid: WeekGrid }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 720);
  const [hover, setHover] = useState<{ wd: number; h: number } | null>(null);
  const { rows, perDay, peak } = props.grid;
  const marginal = width >= 640;
  const plotW = Math.max(240, width - PAD.left - (marginal ? MARGINAL_W : 0));
  const cellW = plotW / 24;
  const H = PAD.top + 7 * ROW_H + PAD.bottom;
  const max = Math.max(0, ...rows.flatMap((r) => r.map(mean)));
  const maxDay = Math.max(1, ...perDay);
  const peakHours = peak ? Array.from({ length: 3 }, (_, i) => (peak.hours.from + i) % 24) : [];
  const cx = (h: number) => PAD.left + h * cellW;
  const cy = (wd: number) => PAD.top + wd * ROW_H;
  const hovered = hover ? rows[hover.wd]![hover.h]! : null;

  return (
    <div className="chart heatmap" ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={peak ? `Requests by weekday and hour. Busiest ${weekdayName(peak.weekday)}, ${hourText(peak.hours.from)} to ${hourText(peak.hours.to)}` : 'Requests by weekday and hour'}>
        {Array.from({ length: 8 }, (_, i) => i * 3).map((h) => (
          <text key={h} x={cx(h) + (h === 24 ? 0 : cellW / 2)} y={PAD.top - 14} textAnchor="middle" className="tick">
            {h === 24 ? '' : String(h).padStart(2, '0')}
          </text>
        ))}
        {peakHours.map((h) => (
          <rect key={`pk${h}`} x={cx(h) + 1} y={PAD.top - 9} width={cellW - 2} height={3} rx={1.5} className="peak-bracket" />
        ))}
        {rows.map((row, wd) => (
          <g key={wd}>
            <text x={PAD.left - 10} y={cy(wd) + (ROW_H - GAP) / 2} dy="0.32em" textAnchor="end" className={`tick ${peak?.weekday === wd ? 'peak-label' : ''}`}>
              {weekdayName(wd, 'short')}
            </text>
            {row.map((c) => {
              const step = stepOf(mean(c), max);
              return (
                <rect
                  key={c.hour}
                  x={cx(c.hour) + GAP / 2}
                  y={cy(wd)}
                  width={Math.max(2, cellW - GAP)}
                  height={ROW_H - GAP}
                  rx={4}
                  fill={step < 0 ? 'var(--surface-2)' : RAMP[step]}
                  className={hover?.wd === wd && hover.h === c.hour ? 'cell hovered' : 'cell'}
                  onPointerEnter={() => setHover({ wd, h: c.hour })}
                />
              );
            })}
            {marginal && (
              <g>
                <rect x={PAD.left + plotW + 16} y={cy(wd) + (ROW_H - GAP) / 2 - 4} width={Math.max(2, ((perDay[wd] ?? 0) / maxDay) * (MARGINAL_W - 76))} height={8} rx={4} fill={peak?.weekday === wd ? 'var(--ice-5)' : 'var(--ice-3)'} />
                <text x={PAD.left + plotW + MARGINAL_W - 4} y={cy(wd) + (ROW_H - GAP) / 2} dy="0.32em" textAnchor="end" className={`tick num ${peak?.weekday === wd ? 'peak-label' : ''}`}>
                  {count(perDay[wd] ?? 0)}
                </text>
              </g>
            )}
          </g>
        ))}
        {marginal && (
          <text x={PAD.left + plotW + 16} y={PAD.top - 14} className="tick">
            per day
          </text>
        )}
      </svg>
      {hover && hovered && (
        <ChartTip
          left={Math.min(Math.max(0, cx(hover.h) + cellW + 8), width - TIP_W - 4) > cx(hover.h) ? cx(hover.h) + cellW + 8 : Math.max(0, cx(hover.h) - TIP_W - 8)}
          top={cy(hover.wd) - 6}
          width={TIP_W}
          title={`${weekdayName(hover.wd)}s, ${hourText(hover.h)}–${hourText(hover.h + 1)}`}
          rows={[
            { key: 'mean', value: count(mean(hovered)), label: 'requests an hour, on average' },
            { key: 'n', value: String(hovered.occurrences), label: hovered.occurrences === 1 ? `${weekdayName(hover.wd)} counted` : `${weekdayName(hover.wd)}s counted` },
          ]}
        />
      )}
      <div className="scale" aria-hidden>
        <span>0</span>
        <span className="scale-steps">
          {RAMP.map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
        </span>
        <span>{count(max)} requests an hour</span>
      </div>
    </div>
  );
});
