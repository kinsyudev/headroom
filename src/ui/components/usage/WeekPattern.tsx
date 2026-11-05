import { useMemo } from 'react';
import type { AnalyticsView } from '../../../shared/view';
import { count, hourText, weekdayName } from '../../format';
import { ChartCard } from '../charts/ChartCard';
import { Heatmap } from '../charts/Heatmap';

/** When you use Claude: a usual week, hour by hour. It needs a month to be a pattern, so it ignores the range and honours the account and model. */
export function WeekPattern(props: { readonly view: AnalyticsView }) {
  const { week } = props.view;
  const table = useMemo(
    () => ({
      head: ['Day', ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))],
      rows: week.rows.map((row, wd) => [weekdayName(wd, 'short'), ...row.map((c) => (c.occurrences === 0 ? '0' : count(c.stats.requests / c.occurrences)))]),
    }),
    [week],
  );
  return (
    <ChartCard
      title="When you use Claude"
      sub="A usual week: average requests in each hour, last 30 days, local time"
      table={table}
      testId="week-pattern"
    >
      <Heatmap grid={week} />
      {week.peak && (
        <p className="callout">
          <strong>{weekdayName(week.peak.weekday)}s</strong> are the heaviest day, and the heaviest stretch is{' '}
          <strong>
            {hourText(week.peak.hours.from)}–{hourText(week.peak.hours.to)}
          </strong>
          . The bracket above the grid marks it.
        </p>
      )}
    </ChartCard>
  );
}
