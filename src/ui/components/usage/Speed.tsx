import { useMemo } from 'react';
import type { AnalyticsView, Percentiles } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, count, seconds } from '../../format';
import { ChartCard, Legend } from '../charts/ChartCard';
import { LineChart } from '../charts/LineChart';
import { RANGE_LABEL } from './Toolbar';

const P50 = 'var(--ice-5)';
const P90 = 'var(--ice-3)';

/** One speed measure over time: the median and the slow end, on one scale that starts at zero. A bucket with under 20 samples leaves a gap. */
function SpeedChart(props: { readonly title: string; readonly sub: string; readonly view: AnalyticsView; readonly pick: (b: AnalyticsView['timeline'][number]) => Percentiles | null; readonly total: Percentiles | null }) {
  const now = useNow();
  const v = props.view;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const series = useMemo(
    () => [
      { key: 'p50', label: 'Median', end: 'median', color: P50, values: v.timeline.map((b) => props.pick(b)?.p50 ?? null) },
      { key: 'p90', label: 'Slowest 10%', end: 'slowest 10%', color: P90, values: v.timeline.map((b) => props.pick(b)?.p90 ?? null) },
    ],
    [v.timeline, props.pick],
  );
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Median', 'Slowest 10%', 'Slowest 1%', 'Samples'],
      rows: v.timeline.map((b) => {
        const p = props.pick(b);
        return [span(b), seconds(p?.p50 ?? null), seconds(p?.p90 ?? null), seconds(p?.p99 ?? null), p ? count(p.samples) : '—'];
      }),
    }),
    [v.timeline, props.pick, now],
  );
  const t = props.total;
  return (
    <ChartCard
      title={props.title}
      sub={props.sub}
      legend={<Legend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, line: true }))} />}
      table={table}
    >
      <div className="figures">
        <div>
          <p className="figure">{seconds(t?.p50 ?? null)}</p>
          <p className="figure-label">median</p>
        </div>
        <div>
          <p className="figure">{seconds(t?.p90 ?? null)}</p>
          <p className="figure-label">slowest 10%</p>
        </div>
        <div>
          <p className="figure">{seconds(t?.p99 ?? null)}</p>
          <p className="figure-label">slowest 1%</p>
        </div>
      </div>
      <LineChart
        buckets={v.timeline}
        series={series}
        format={seconds}
        axisFormat={(n) => `${n / 1000}s`}
        bucketLabel={label}
        tooltipTitle={title}
        label={`${props.title}, median and slowest 10%`}
        extra={(i) => {
          const p = props.pick(v.timeline[i]!);
          return p ? (
            <>
              <div className="tooltip-row">
                <span className="line-key off" />
                <strong className="num">{seconds(p.p99)}</strong>
                <span className="muted">Slowest 1%</span>
              </div>
              <div className="tooltip-row total">
                <strong className="num">{count(p.samples)}</strong>
                <span className="muted">requests</span>
              </div>
            </>
          ) : null;
        }}
      />
    </ChartCard>
  );
}

export function Speed(props: { readonly view: AnalyticsView }) {
  const range = RANGE_LABEL[props.view.lens.range].toLowerCase();
  return (
    <div className="grid-2 even" data-testid="speed">
      <SpeedChart title="Time to first token" sub={`How long until Claude starts answering · ${range}`} view={props.view} pick={(b) => b.total.ttftMs} total={props.view.total.ttftMs} />
      <SpeedChart title="Time to finish" sub={`How long a whole answer takes · ${range}`} view={props.view} pick={(b) => b.total.latencyMs} total={props.view.total.latencyMs} />
    </div>
  );
}
