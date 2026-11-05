import { useMemo, useState } from 'react';
import type { AccountId } from '../../../shared/domain';
import type { AnalyticsView, UsageStats } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, compact, count } from '../../format';
import { ChartCard, Legend } from '../charts/ChartCard';
import { StackedColumns, type Bucket } from '../charts/StackedColumns';
import { Switch } from '../charts/Switch';
import { RANGE_LABEL } from './Toolbar';

type Metric = 'requests' | 'sessions' | 'output';

const METRICS: readonly { readonly key: Metric; readonly label: string; readonly noun: string; readonly title: string }[] = [
  { key: 'requests', label: 'Requests', noun: 'Requests', title: 'Requests, failed ones included' },
  { key: 'sessions', label: 'Sessions', noun: 'Sessions started', title: 'Claude Code sessions, counted in the hour their first request arrived' },
  { key: 'output', label: 'Output tokens', noun: 'Output tokens', title: 'Tokens Claude wrote back' },
];

const metricOf = (s: UsageStats, m: Metric) => (m === 'requests' ? s.requests : m === 'sessions' ? s.sessions : s.tokens.output);

const LAST_WEEK_NAME = 'Same day last week';

/** Today is part of a day, so last week's figure for it stops at the same time, and the tooltip says so. */
const LAST_WEEK = (b: Bucket): string => (b.partial ? 'Last week, to this time' : LAST_WEEK_NAME);

/** How much, over time, and by which account. Wide enough to read a week by the hour or a month by the day. */
export function OverTime(props: { readonly view: AnalyticsView; readonly colors: ReadonlyMap<AccountId, string>; readonly dim: boolean }) {
  const [metric, setMetric] = useState<Metric>('requests');
  const now = useNow();
  const v = props.view;
  const m = METRICS.find((x) => x.key === metric)!;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const format = metric === 'output' ? compact : count;
  const series = useMemo(
    () =>
      v.dimensions.accounts.map((a, j) => ({
        key: a.id as string,
        label: a.email,
        color: props.colors.get(a.id)!,
        values: v.timeline.map((b) => metricOf(b.byAccount[j]!.stats, metric)),
      })),
    // v changes identity every second; its timeline does not
    [v.timeline, v.dimensions, props.colors, metric],
  );
  const lastWeek = v.lens.range === '7d' && v.previous !== null;
  const previous = useMemo(
    () => (lastWeek ? { label: LAST_WEEK, values: v.timeline.map((b) => (b.previous ? metricOf(b.previous.stats, metric) : null)) } : undefined),
    [lastWeek, v.timeline, metric],
  );
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', ...series.map((s) => s.label), 'Total', ...(previous ? [LAST_WEEK_NAME] : [])],
      rows: v.timeline.map((b, i) => [
        b.partial ? `${span(b)} · now` : span(b),
        ...series.map((s) => (s.values[i] ?? 0).toLocaleString()),
        series.reduce((n, s) => n + (s.values[i] ?? 0), 0).toLocaleString(),
        ...(previous ? [previous.values[i]?.toLocaleString() ?? '—'] : []),
      ]),
    }),
    [series, previous, v.timeline, now],
  );

  return (
    <ChartCard
      title={`${m.noun} over time`}
      sub={`${RANGE_LABEL[v.lens.range]} · per ${v.lens.grain} · by account`}
      actions={<Switch label="Measure" options={METRICS} value={metric} onChange={setMetric} />}
      legend={<Legend items={[...series.map((s) => ({ key: s.key, label: s.label, color: s.color })), ...(previous ? [{ key: 'last-week', label: LAST_WEEK_NAME, color: 'var(--ink)', line: true }] : [])]} />}
      table={table}
      testId="over-time"
    >
      <StackedColumns
        buckets={v.timeline}
        series={series}
        format={format}
        bucketLabel={label}
        tooltipTitle={title}
        label={`${m.noun} per ${v.lens.grain}, stacked by account${previous ? `, with ${LAST_WEEK_NAME.toLowerCase()} marked` : ''}`}
        dim={props.dim}
        height={260}
        previous={previous}
      />
    </ChartCard>
  );
}
