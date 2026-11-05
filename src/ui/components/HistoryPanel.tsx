import { useMemo, useState } from 'react';
import type { AccountId } from '../../shared/domain';
import { USAGE_RANGES, type AccountView, type UsageRange, type UsageStats } from '../../shared/view';
import { useAnalytics } from '../api';
import { useNow } from '../deck';
import { bucketText, compact } from '../format';
import { Age } from './Countdown';
import { Legend } from './charts/ChartCard';
import { StackedColumns, type Bucket } from './charts/StackedColumns';
import { Switch } from './charts/Switch';
import { Segments } from './Segments';
import { TableScroll } from './TableScroll';

type Metric = 'requests' | 'freshInput' | 'cacheRead' | 'output';

const METRICS: readonly { readonly key: Metric; readonly label: string; readonly title: string }[] = [
  { key: 'requests', label: 'Requests', title: 'Requests, failed ones included' },
  {
    key: 'freshInput',
    label: 'Uncached input',
    title: "Input tokens that were neither read from the cache nor written to it. The request log's input count already includes both for Claude, so they are subtracted",
  },
  { key: 'cacheRead', label: 'Cache read', title: 'Cache read tokens' },
  { key: 'output', label: 'Output', title: 'Output tokens' },
];

const metricOf = (s: UsageStats, m: Metric) => (m === 'requests' ? s.requests : s.tokens[m]);

const RANGE_LABEL: Readonly<Record<UsageRange, string>> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };

type Face = 'chart' | 'table';

const FACES: readonly { readonly key: Face; readonly label: string }[] = [
  { key: 'chart', label: 'Chart' },
  { key: 'table', label: 'Table' },
];

/** Recent traffic by account, where the accounts are. Heatmap, mix, cache, speed, failures and pace are in Usage. */
export function HistoryPanel(props: { readonly accounts: readonly AccountView[]; readonly colors: ReadonlyMap<AccountId, string> }) {
  const [range, setRange] = useState<UsageRange>('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const [face, setFace] = useState<Face>('chart');
  const state = useAnalytics({ range }, props.accounts);
  const usage = state.kind === 'ready' ? state.view : null;
  const loading = state.kind === 'loading' || (state.kind === 'ready' && (state.refreshing || state.view.catchingUp));
  const error = state.kind === 'failed' || state.kind === 'ready' ? state.error : null;
  const now = useNow();

  const timeline = usage?.timeline;
  const series = useMemo(
    () =>
      usage
        ? usage.dimensions.accounts.map((a, j) => ({
            key: a.id,
            label: a.email,
            color: props.colors.get(a.id)!,
            values: usage.timeline.map((b) => metricOf(b.byAccount[j]!.stats, metric)),
          }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- usage changes identity every second; its timeline does not
    [timeline, props.colors, metric],
  );
  const limited = (i: number) => usage?.timeline[i]?.total.outcomes.rate_limited ?? 0;
  const { label, span, title } = bucketText(usage?.lens.grain ?? 'hour', now);

  return (
    <section className="panel history" aria-label="History" data-testid="history">
      <div className="panel-head">
        <h2>Activity</h2>
        <Switch label="Range" options={USAGE_RANGES.map((r) => ({ key: r, label: r }))} value={range} onChange={setRange} testId={(r) => `range-${r}`} />
        <Switch label="Metric" options={METRICS} value={metric} onChange={setMetric} className="metrics" />
        <Switch className="view" label="View" options={FACES} value={face} onChange={setFace} />
      </div>
      {error && <p className="banner warning">History unavailable: {error}</p>}
      {(usage || loading) && (
        <div className="legend">
          <span className="muted">
            <Segments
              parts={[
                RANGE_LABEL[range],
                usage && `per ${usage.lens.grain}`,
                usage && 'local time',
                usage?.keeperLatestAt && (
                  <>
                    latest request <Age at={usage.keeperLatestAt} /> ago
                  </>
                ),
                loading && 'loading',
              ]}
            />
          </span>
          {series.length > 0 && <Legend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />}
        </div>
      )}
      {usage &&
        (face === 'table' ? (
          <TableScroll label={`Usage per ${usage.lens.grain}`}>
            <table className="data">
              <thead>
                <tr>
                  <th>{usage.lens.grain === 'hour' ? 'Hour' : 'Day'}</th>
                  {series.map((s) => (
                    <th key={s.key} className="num">
                      {s.label}
                    </th>
                  ))}
                  <th className="num wrap" title="Requests answered with HTTP 429">
                    Rate-limited
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.timeline.map((b, i) => (
                  <tr key={b.start}>
                    <td>{b.partial ? `${span(b)} · now` : span(b)}</td>
                    {series.map((s) => (
                      <td key={s.key} className="num">
                        {(s.values[i] ?? 0).toLocaleString()}
                      </td>
                    ))}
                    <td className="num">{limited(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : (
          <StackedColumns
            buckets={usage.timeline}
            series={series}
            format={compact}
            bucketLabel={label}
            tooltipTitle={title}
            label="Stacked usage per account"
            dim={loading}
            extra={(i) =>
              limited(i) > 0 ? (
                <div className="tooltip-row">
                  <strong className="num">{limited(i)}</strong>
                  <span className="muted">rate-limited</span>
                </div>
              ) : null
            }
          />
        ))}
      <p className="panel-foot">
        <a className="jump" href="#usage">
          Open Usage for pace, busiest hours, models, cache, speed and failures →
        </a>
      </p>
    </section>
  );
}
