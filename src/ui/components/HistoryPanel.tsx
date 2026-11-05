import { useMemo, useState, type ReactNode } from 'react';
import type { AccountId } from '../../shared/domain';
import { USAGE_RANGES, type AccountView, type AnalyticsView, type UsageRange, type UsageStats } from '../../shared/view';
import { useAnalytics } from '../api';
import { useNow } from '../deck';
import { clockTime, compact, reasonText } from '../format';
import { Age, Clock } from './Countdown';
import { Segments } from './Segments';
import { StackedColumns, type Bucket } from './StackedColumns';
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

type ModelRow = AnalyticsView['byAccountModel'][number];

interface RowAccount {
  readonly email: string;
  readonly color: string | undefined;
}

type View = 'chart' | 'table';

const VIEWS: readonly { readonly key: View; readonly label: string }[] = [
  { key: 'chart', label: 'Chart' },
  { key: 'table', label: 'Table' },
];

type ColumnGroup = 'usage' | 'cache';

const COLUMN_GROUPS: readonly { readonly key: ColumnGroup; readonly label: string }[] = [
  { key: 'usage', label: 'Usage' },
  { key: 'cache', label: 'Cache and latency' },
];

function Switch<T extends string>(props: {
  readonly label: string;
  readonly options: readonly { readonly key: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (key: T) => void;
  readonly className?: string;
}) {
  return (
    <div className={`segmented ${props.className ?? ''}`} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.key} type="button" className={`btn small ${o.key === props.value ? 'selected' : 'quiet'}`} aria-pressed={o.key === props.value} onClick={() => props.onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface ModelColumn {
  readonly label: string;
  readonly title?: string;
  readonly group?: ColumnGroup;
  readonly num?: boolean;
  readonly cell: (m: ModelRow, account: RowAccount | undefined) => ReactNode;
}

const RATE_LIMITED_TITLE = 'Requests answered with HTTP 429';

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);


const MODEL_COLUMNS: readonly ModelColumn[] = [
  {
    label: 'Account',
    cell: (m, account) => (
      <>
        <span className="swatch small" style={{ background: account?.color }} /> {account?.email ?? m.account}
      </>
    ),
  },
  { label: 'Model', cell: (m) => m.model },
  { label: 'Requests', group: 'usage', num: true, cell: (m) => m.stats.requests.toLocaleString() },
  { label: 'Failed', group: 'usage', num: true, cell: (m) => m.stats.requests - m.stats.outcomes.ok },
  { label: 'Rate-limited', title: RATE_LIMITED_TITLE, group: 'usage', num: true, cell: (m) => m.stats.outcomes.rate_limited },
  { label: 'Uncached in', title: METRICS[1]!.title, group: 'cache', num: true, cell: (m) => compact(m.stats.tokens.freshInput) },
  { label: 'Cache read', group: 'cache', num: true, cell: (m) => compact(m.stats.tokens.cacheRead) },
  { label: 'Cache write', group: 'cache', num: true, cell: (m) => compact(m.stats.tokens.cacheCreation) },
  { label: 'Output', group: 'usage', num: true, cell: (m) => compact(m.stats.tokens.output) },
  { label: 'Latency', title: 'Median latency of successful requests', group: 'cache', num: true, cell: (m) => seconds(m.stats.latencyMs?.p50 ?? null) },
  { label: 'First token', title: 'Median time to first token (TTFT) of successful requests', group: 'cache', num: true, cell: (m) => seconds(m.stats.ttftMs?.p50 ?? null) },
];

export function HistoryPanel(props: { readonly accounts: readonly AccountView[]; readonly colors: ReadonlyMap<AccountId, string> }) {
  const [range, setRange] = useState<UsageRange>('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const [view, setView] = useState<View>('chart');
  const [group, setGroup] = useState<ColumnGroup>('usage');
  const state = useAnalytics({ range }, props.accounts);
  const usage = state.kind === 'ready' ? state.view : null;
  const loading = state.kind === 'loading' || (state.kind === 'ready' && (state.refreshing || state.view.catchingUp));
  const error = state.kind === 'failed' || state.kind === 'ready' ? state.error : null;
  const now = useNow();

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
    [usage, props.colors, metric],
  );
  const limited = (i: number) => usage?.timeline[i]?.total.outcomes.rate_limited ?? 0;
  const columns = MODEL_COLUMNS.filter((c) => !c.group || c.group === group);
  const grain = usage?.lens.grain;
  const label = (b: Bucket) => {
    if (b.partial) return 'now';
    return grain === 'hour' ? new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : new Date(b.start).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const span = (b: Bucket) =>
    grain === 'hour' ? `${clockTime(b.start, now)}–${clockTime(b.end, now)}` : new Date(b.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const title = (b: Bucket) => (b.partial ? `${span(b)} · in progress` : span(b));
  const accountOf = (id: AccountId): RowAccount | undefined => {
    const a = props.accounts.find((x) => x.id === id);
    return a && { email: a.email, color: props.colors.get(id) };
  };

  return (
    <section className="panel history" aria-label="History" data-testid="history">
      <div className="panel-head">
        <h2>History</h2>
        <div className="segmented" role="group" aria-label="Range">
          {USAGE_RANGES.map((r) => (
            <button key={r} type="button" className={`btn ${r === range ? 'selected' : 'quiet'}`} aria-pressed={r === range} onClick={() => setRange(r)} data-testid={`range-${r}`}>
              {r}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Metric">
          {METRICS.map((m) => (
            <button key={m.key} type="button" className={`btn ${m.key === metric ? 'selected' : 'quiet'}`} aria-pressed={m.key === metric} title={m.title} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
        <Switch className="view" label="View" options={VIEWS} value={view} onChange={setView} />
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
          {series.length > 0 && (
            <span className="legend-items">
              {series.map((s) => (
                <span key={s.key} className="legend-item">
                  <span className="legend-swatch" style={{ background: s.color }} /> {s.label}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {usage && (
        <>
          {view === 'table' ? (
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
                    <th className="num wrap" title={RATE_LIMITED_TITLE}>
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
          )}
        </>
      )}

      {usage && (
        <div className="history-tables">
          <div className="history-table">
            <div className="table-head">
              <h3>Per model · {RANGE_LABEL[range].toLowerCase()}</h3>
              <Switch label="Columns" options={COLUMN_GROUPS} value={group} onChange={setGroup} />
            </div>
            <TableScroll label="Per model totals">
              <table className="data">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.label} className={c.num ? 'num' : undefined} title={c.title}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {usage.byAccountModel.length === 0 && (
                    <tr>
                      <td colSpan={columns.length} className="muted">
                        No requests in this range.
                      </td>
                    </tr>
                  )}
                  {usage.byAccountModel.map((m) => (
                    <tr key={`${m.account}:${m.model}`}>
                      {columns.map((c) => (
                        <td key={c.label} className={c.num ? 'num' : undefined}>
                          {c.cell(m, accountOf(m.account))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
          <div className="history-table">
            <h3>Recent errors and rate limits</h3>
            <TableScroll label="Recent errors and rate limits">
              <table className="data errors">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Account</th>
                    <th className="num">Status</th>
                    <th>Quota reason</th>
                    <th>Recovers</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.errors.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No errors in this range.
                      </td>
                    </tr>
                  )}
                  {usage.errors.map((e) => (
                    <tr key={e.id}>
                      <td>{e.at !== null ? <Clock at={e.at} /> : '—'}</td>
                      <td>{e.email ?? e.account ?? '—'}</td>
                      <td className="num">{e.status ?? '—'}</td>
                      <td title={e.quotaReason ?? undefined}>{e.quotaReason === null ? '—' : reasonText(e.quotaReason)}</td>
                      <td>{e.recoverAt !== null ? <Clock at={e.recoverAt} /> : '—'}</td>
                      <td className="message" title={e.message}>
                        {e.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        </div>
      )}
    </section>
  );
}
