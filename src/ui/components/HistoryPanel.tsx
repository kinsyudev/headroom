import { useMemo, useState, type ReactNode } from 'react';
import type { AccountId } from '../../shared/domain';
import { foldHistory, HISTORY_RANGES, ZERO_TOTALS, type HistoryRange, type ModelRow, type TokenTotals } from '../../shared/history';
import { useHistory } from '../api';
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

const RANGE_LABEL: Readonly<Record<HistoryRange, string>> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };

export interface HistoryAccount {
  readonly id: AccountId;
  readonly email: string;
  readonly color: string;
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
  readonly cell: (m: ModelRow, account: HistoryAccount | undefined) => ReactNode;
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
  { label: 'Requests', group: 'usage', num: true, cell: (m) => m.totals.requests.toLocaleString() },
  { label: 'Failed', group: 'usage', num: true, cell: (m) => m.totals.failed },
  { label: 'Rate-limited', title: RATE_LIMITED_TITLE, group: 'usage', num: true, cell: (m) => m.totals.rateLimited },
  { label: 'Uncached in', title: METRICS[1]!.title, group: 'cache', num: true, cell: (m) => compact(m.totals.freshInput) },
  { label: 'Cache read', group: 'cache', num: true, cell: (m) => compact(m.totals.cacheRead) },
  { label: 'Cache write', group: 'cache', num: true, cell: (m) => compact(m.totals.cacheCreation) },
  { label: 'Output', group: 'usage', num: true, cell: (m) => compact(m.totals.output) },
  { label: 'Latency', group: 'cache', num: true, cell: (m) => seconds(m.avgLatencyMs) },
  { label: 'First token', title: 'Average time to first token (TTFT)', group: 'cache', num: true, cell: (m) => seconds(m.avgTtftMs) },
];

export function HistoryPanel(props: { readonly accounts: readonly HistoryAccount[] }) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const [view, setView] = useState<View>('chart');
  const [group, setGroup] = useState<ColumnGroup>('usage');
  const { history, loading, error } = useHistory(range);
  const now = useNow();

  const folded = useMemo(() => (history ? foldHistory(history.hours, history.range, history.generatedAt) : null), [history]);
  const series = useMemo(
    () =>
      folded
        ? props.accounts.map((a) => ({
            key: a.id,
            label: a.email,
            color: a.color,
            values: folded.buckets.map((b) => (b.byAccount.get(a.id) ?? ZERO_TOTALS)[metric]),
          }))
        : [],
    [folded, props.accounts, metric],
  );
  const limited = (i: number) => [...(folded?.buckets[i]?.byAccount.values() ?? [])].reduce((n, t: TokenTotals) => n + t.rateLimited, 0);
  const columns = MODEL_COLUMNS.filter((c) => !c.group || c.group === group);
  const label = (b: Bucket) => {
    if (b.partial) return 'now';
    return folded?.bucket === 'hour' ? new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : new Date(b.start).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const span = (b: Bucket) =>
    folded?.bucket === 'hour' ? `${clockTime(b.start, now)}–${clockTime(b.end, now)}` : new Date(b.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const title = (b: Bucket) => (b.partial ? `${span(b)} · in progress` : span(b));
  const emailOf = (id: AccountId | null) => props.accounts.find((a) => a.id === id);

  return (
    <section className="panel history" aria-label="History" data-testid="history">
      <div className="panel-head">
        <h2>History</h2>
        <div className="segmented" role="group" aria-label="Range">
          {HISTORY_RANGES.map((r) => (
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
      {(folded || loading) && (
        <div className="legend">
          <span className="muted">
            <Segments
              parts={[
                RANGE_LABEL[range],
                folded && `per ${folded.bucket}`,
                folded && 'local time',
                history?.keeperLatestAt && (
                  <>
                    latest request <Age at={history.keeperLatestAt} /> ago
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
      {folded && (
        <>
          {view === 'table' ? (
            <TableScroll label={`Usage per ${folded.bucket}`}>
              <table className="data">
                <thead>
                  <tr>
                    <th>{folded.bucket === 'hour' ? 'Hour' : 'Day'}</th>
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
                  {folded.buckets.map((b, i) => (
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
              buckets={folded.buckets}
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

      {history && (
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
                  {history.models.length === 0 && (
                    <tr>
                      <td colSpan={columns.length} className="muted">
                        No requests in this range.
                      </td>
                    </tr>
                  )}
                  {history.models.map((m) => (
                    <tr key={`${m.account}:${m.model}`}>
                      {columns.map((c) => (
                        <td key={c.label} className={c.num ? 'num' : undefined}>
                          {c.cell(m, emailOf(m.account))}
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
                  {history.errors.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No errors recorded.
                      </td>
                    </tr>
                  )}
                  {history.errors.map((e) => (
                    <tr key={e.id}>
                      <td>{e.at !== null ? <Clock at={e.at} /> : '—'}</td>
                      <td>{emailOf(e.account)?.email ?? e.account ?? '—'}</td>
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
