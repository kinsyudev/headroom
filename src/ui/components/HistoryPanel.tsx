import { useMemo, useState, type ReactNode } from 'react';
import type { AccountId } from '../../shared/domain';
import { foldHistory, HISTORY_RANGES, ZERO_TOTALS, type HistoryRange, type ModelRow, type TokenTotals } from '../../shared/history';
import { useHistory } from '../api';
import { useNow } from '../deck';
import { clockTime, compact, reasonText } from '../format';
import { Age, Clock } from './Countdown';
import { Segments } from './Segments';
import { StackedColumns } from './StackedColumns';
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

type ColumnGroup = 'usage' | 'cache';

const COLUMN_GROUPS: readonly { readonly key: ColumnGroup; readonly label: string }[] = [
  { key: 'usage', label: 'Usage' },
  { key: 'cache', label: 'Cache and latency' },
];

interface ModelColumn {
  readonly label: string;
  readonly title?: string;
  readonly group?: ColumnGroup;
  readonly num?: boolean;
  readonly cell: (m: ModelRow, account: HistoryAccount | undefined) => ReactNode;
}

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
  { label: '429', title: 'Rate-limited (HTTP 429)', group: 'usage', num: true, cell: (m) => m.totals.rateLimited },
  { label: 'Uncached in', title: METRICS[1]!.title, group: 'cache', num: true, cell: (m) => compact(m.totals.freshInput) },
  { label: 'Cache read', group: 'cache', num: true, cell: (m) => compact(m.totals.cacheRead) },
  { label: 'Cache write', group: 'cache', num: true, cell: (m) => compact(m.totals.cacheCreation) },
  { label: 'Output', group: 'usage', num: true, cell: (m) => compact(m.totals.output) },
  { label: 'Latency', group: 'cache', num: true, cell: (m) => seconds(m.avgLatencyMs) },
  { label: 'First token', title: 'Average time to first token (TTFT)', group: 'cache', num: true, cell: (m) => seconds(m.avgTtftMs) },
];

const columnClass = (c: ModelColumn) => [c.num && 'num', c.group && `col-${c.group}`].filter(Boolean).join(' ') || undefined;

export function HistoryPanel(props: { readonly accounts: readonly HistoryAccount[] }) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const [table, setTable] = useState(false);
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
  const label = (start: number) =>
    folded?.bucket === 'hour' ? new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const title = (start: number, end: number) =>
    folded?.bucket === 'hour' ? `${clockTime(start, now)}–${clockTime(end, now)}` : new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
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
        <button type="button" className="btn quiet" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? 'Chart' : 'Table'}
        </button>
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
          {table ? (
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
                    <th className="num">429s</th>
                  </tr>
                </thead>
                <tbody>
                  {folded.buckets.map((b, i) => (
                    <tr key={b.start}>
                      <td>{title(b.start, b.end)}</td>
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
                    <span className="muted">rate-limited (429)</span>
                  </div>
                ) : null
              }
            />
          )}
        </>
      )}

      {history && (
        <div className="history-tables">
          <div className="history-table" data-group={group}>
            <div className="table-head">
              <h3>Per model · {RANGE_LABEL[range].toLowerCase()}</h3>
              <div className="segmented columns" role="group" aria-label="Columns">
                {COLUMN_GROUPS.map((g) => (
                  <button key={g.key} type="button" className={`btn small ${g.key === group ? 'selected' : 'quiet'}`} aria-pressed={g.key === group} onClick={() => setGroup(g.key)}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <TableScroll label="Per model totals">
              <table className="data">
                <thead>
                  <tr>
                    {MODEL_COLUMNS.map((c) => (
                      <th key={c.label} className={columnClass(c)} title={c.title}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.models.length === 0 && (
                    <tr>
                      <td colSpan={MODEL_COLUMNS.length} className="muted">
                        No requests in this range.
                      </td>
                    </tr>
                  )}
                  {history.models.map((m) => (
                    <tr key={`${m.account}:${m.model}`}>
                      {MODEL_COLUMNS.map((c) => (
                        <td key={c.label} className={columnClass(c)}>
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
            <h3>Recent errors and 429s</h3>
            <TableScroll label="Recent errors and 429s">
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
