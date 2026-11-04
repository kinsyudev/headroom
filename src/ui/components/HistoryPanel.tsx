import { useMemo, useState } from 'react';
import type { AccountId } from '../../shared/domain';
import { foldHistory, HISTORY_RANGES, ZERO_TOTALS, type HistoryRange, type TokenTotals } from '../../shared/history';
import { useHistory } from '../api';
import { useNow } from '../deck';
import { clockTime, compact, reasonText } from '../format';
import { Age, Clock } from './Countdown';
import { Segments } from './Segments';
import { StackedColumns } from './StackedColumns';

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

export function HistoryPanel(props: { readonly accounts: readonly HistoryAccount[] }) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const [table, setTable] = useState(false);
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
        <span className="muted keeper-age">
          <Segments
            parts={[
              history?.keeperLatestAt && (
                <>
                  latest request <Age at={history.keeperLatestAt} /> ago
                </>
              ),
              loading && 'loading',
            ]}
          />
        </span>
      </div>
      {error && <p className="banner warning">History unavailable: {error}</p>}
      {folded && (
        <>
          <div className="legend">
            <span className="muted">
              <Segments parts={[RANGE_LABEL[range], `per ${folded.bucket}`, 'local time']} />
            </span>
            {series.map((s) => (
              <span key={s.key} className="legend-item">
                <span className="legend-swatch" style={{ background: s.color }} /> {s.label}
              </span>
            ))}
          </div>
          {table ? (
            <div className="table-wrap">
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
            </div>
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
          <div className="table-wrap">
            <h3>Per model · {RANGE_LABEL[range].toLowerCase()}</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Model</th>
                  <th className="num">Requests</th>
                  <th className="num">Failed</th>
                  <th className="num">429</th>
                  <th className="num" title={METRICS[1]!.title}>
                    Uncached in
                  </th>
                  <th className="num">Cache read</th>
                  <th className="num">Cache write</th>
                  <th className="num">Output</th>
                  <th className="num">Latency</th>
                  <th className="num" title="Average time to first token (TTFT)">
                    First token
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.models.length === 0 && (
                  <tr>
                    <td colSpan={11} className="muted">
                      No requests in this range.
                    </td>
                  </tr>
                )}
                {history.models.map((m) => (
                  <tr key={`${m.account}:${m.model}`}>
                    <td>
                      <span className="swatch small" style={{ background: emailOf(m.account)?.color }} /> {emailOf(m.account)?.email ?? m.account}
                    </td>
                    <td>{m.model}</td>
                    <td className="num">{m.totals.requests.toLocaleString()}</td>
                    <td className="num">{m.totals.failed}</td>
                    <td className="num">{m.totals.rateLimited}</td>
                    <td className="num">{compact(m.totals.freshInput)}</td>
                    <td className="num">{compact(m.totals.cacheRead)}</td>
                    <td className="num">{compact(m.totals.cacheCreation)}</td>
                    <td className="num">{compact(m.totals.output)}</td>
                    <td className="num">{m.avgLatencyMs === null ? '—' : `${(m.avgLatencyMs / 1000).toFixed(1)}s`}</td>
                    <td className="num">{m.avgTtftMs === null ? '—' : `${(m.avgTtftMs / 1000).toFixed(1)}s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <h3>Recent errors and 429s</h3>
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
          </div>
        </div>
      )}
    </section>
  );
}
