import { useMemo, useState } from 'react';
import type { AnalyticsView, Percentiles, UsageStats } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, count, seconds } from '../../format';
import { ChartCard, Legend } from '../charts/ChartCard';
import { Key } from '../charts/Key';
import { LineChart } from '../charts/LineChart';
import { Switch } from '../charts/Switch';
import { RANGE_LABEL } from './Toolbar';

const P50 = 'var(--ice-5)';
const P90 = 'var(--ice-6)';

type Measure = 'first' | 'finish';

const MEASURES: readonly { readonly key: Measure; readonly label: string; readonly title: string; readonly sub: string; readonly verb: string; readonly pick: (s: UsageStats) => Percentiles | null }[] = [
  { key: 'first', label: 'First token', title: 'How long until the first token of the answer arrives', sub: 'How long until Claude starts answering', verb: 'start', pick: (s) => s.ttftMs },
  { key: 'finish', label: 'Finish', title: 'How long until the whole answer has arrived', sub: 'How long a whole answer takes', verb: 'finish', pick: (s) => s.latencyMs },
];

/**
 * How fast Claude answers, one measure at a time: the median and the time that 9 in 10 requests beat, on one scale that starts at zero.
 * A bucket with under 20 samples leaves a gap.
 */
export function Speed(props: { readonly view: AnalyticsView }) {
  const [measure, setMeasure] = useState<Measure>('first');
  const now = useNow();
  const v = props.view;
  const m = MEASURES.find((x) => x.key === measure)!;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const nine = `9 in 10 ${m.verb} within`;
  const series = useMemo(
    () => [
      { key: 'p50', label: 'Median', end: 'median', color: P50, values: v.timeline.map((b) => m.pick(b.total)?.p50 ?? null) },
      { key: 'p90', label: nine, end: '9 in 10', color: P90, dash: true, values: v.timeline.map((b) => m.pick(b.total)?.p90 ?? null) },
    ],
    [v.timeline, m],
  );
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Median', `9 in 10 ${m.verb} within`, '99 in 100 within', 'Samples'],
      rows: v.timeline.map((b) => {
        const p = m.pick(b.total);
        return [span(b), seconds(p?.p50 ?? null), seconds(p?.p90 ?? null), seconds(p?.p99 ?? null), p ? count(p.samples) : '—'];
      }),
    }),
    [v.timeline, m, now],
  );
  const t = m.pick(v.total);
  return (
    <ChartCard
      title="Speed"
      sub={`${m.sub} · ${RANGE_LABEL[v.lens.range].toLowerCase()}`}
      actions={<Switch label="Measure" options={MEASURES} value={measure} onChange={setMeasure} />}
      legend={<Legend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, mark: s.dash ? 'dash' : 'line' }))} />}
      table={table}
      testId="speed"
    >
      <div className="figures">
        <div>
          <p className="figure">{seconds(t?.p50 ?? null)}</p>
          <p className="figure-label">median</p>
        </div>
        <div>
          <p className="figure">{seconds(t?.p90 ?? null)}</p>
          <p className="figure-label">{nine}</p>
        </div>
      </div>
      <LineChart
        buckets={v.timeline}
        series={series}
        format={seconds}
        axisFormat={(n) => `${n / 1000}s`}
        bucketLabel={label}
        tooltipTitle={title}
        label={`${m.label} time, median and the time 9 in 10 requests beat`}
        height={180}
        fill
        extra={(i) => {
          const p = m.pick(v.timeline[i]!.total);
          return p ? (
            <>
              <div className="tooltip-row">
                <Key mark="line" color="transparent" />
                <strong className="num">{seconds(p.p99)}</strong>
                <span className="muted">99 in 100 within</span>
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
