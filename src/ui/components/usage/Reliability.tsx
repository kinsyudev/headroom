import { useMemo, useState, type ReactNode } from 'react';
import type { AccountId, Outcome } from '../../../shared/domain';
import type { AnalyticsView, ErrorEventView } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, compact, count, modelName, reasonText, seconds, share } from '../../format';
import { Clock } from '../Countdown';
import { TableScroll } from '../TableScroll';
import { ChartCard, Legend } from '../charts/ChartCard';
import { StackedColumns } from '../charts/StackedColumns';
import { RANGE_LABEL } from './Toolbar';

/**
 * A failure is a status, so it wears the status colours and a glyph: 429 amber, 5xx red. A 499 is the client hanging up, not a fault, so it
 * stays gray, and anything else is neutral.
 */
const FAILURES: readonly { readonly outcome: Exclude<Outcome, 'ok'>; readonly label: string; readonly short: string; readonly icon: string; readonly color: string }[] = [
  { outcome: 'rate_limited', label: '429 rate-limited', short: 'rate-limited', icon: '!', color: 'var(--warning)' },
  { outcome: 'server_error', label: '5xx server error', short: 'server errors', icon: '✕', color: 'var(--critical)' },
  { outcome: 'client_closed', label: '499 cancelled', short: 'cancelled', icon: '○', color: 'var(--quiet)' },
  { outcome: 'other_error', label: 'Other', short: 'other', icon: '·', color: 'var(--axis)' },
];

export function FailuresPanel(props: { readonly view: AnalyticsView; readonly dim: boolean }) {
  const now = useNow();
  const v = props.view;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const series = useMemo(
    () => FAILURES.map((f) => ({ key: f.outcome, label: f.label, color: f.color, values: v.timeline.map((b) => b.total.outcomes[f.outcome]) })),
    [v.timeline],
  );
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Requests', ...FAILURES.map((f) => f.label)],
      rows: v.timeline.map((b) => [span(b), count(b.total.requests), ...FAILURES.map((f) => b.total.outcomes[f.outcome])]),
    }),
    [v.timeline, now],
  );
  const t = v.total;
  const failed = t.requests - t.outcomes.ok;
  return (
    <ChartCard
      title="Failures"
      sub={`Requests that did not succeed · ${RANGE_LABEL[v.lens.range].toLowerCase()}`}
      legend={<Legend items={FAILURES.map((f) => ({ key: f.outcome, label: f.label, color: f.color, icon: f.icon }))} />}
      table={table}
      testId="failures"
    >
      <div className="figures">
        <div>
          <p className="figure">{share(t.rates === null ? null : t.rates.ok)}</p>
          <p className="figure-label">of {count(t.requests)} succeeded</p>
        </div>
        {FAILURES.slice(0, 3).map((f) => (
          <div key={f.outcome}>
            <p className="figure">{count(t.outcomes[f.outcome])}</p>
            <p className="figure-label">
              <span aria-hidden>{f.icon} </span>
              {f.short} · {share(t.rates?.[f.outcome] ?? null)}
            </p>
          </div>
        ))}
        {failed === 0 && <p className="muted">Nothing failed in this range.</p>}
      </div>
      <StackedColumns buckets={v.timeline} series={series} format={count} bucketLabel={label} tooltipTitle={title} label="Failed requests per bucket by kind" dim={props.dim} height={190} />
    </ChartCard>
  );
}

const ROWS_SHOWN = 10;

export function ByModelTable(props: { readonly view: AnalyticsView; readonly colors: ReadonlyMap<AccountId, string> }) {
  const [all, setAll] = useState(false);
  const v = props.view;
  const shown = all ? v.byAccountModel : v.byAccountModel.slice(0, ROWS_SHOWN);
  const emails = new Map(v.dimensions.accounts.map((a) => [a.id, a.email]));
  return (
    <section className="card" aria-label="By account and model" data-testid="by-model">
      <div className="card-head">
        <div className="card-title">
          <h2>By account and model</h2>
          <p>The numbers behind the charts · {RANGE_LABEL[v.lens.range].toLowerCase()}</p>
        </div>
      </div>
      <TableScroll label="Totals by account and model">
        <table className="data">
          <thead>
            <tr>
              <th>Account</th>
              <th>Model</th>
              <th className="num">Requests</th>
              <th className="num">Output</th>
              <th className="num" title="Share of input served from cache">
                Cache hit
              </th>
              <th className="num" title="Median time to first token">
                First token
              </th>
              <th className="num" title="Median time to finish">
                Finish
              </th>
              <th className="num" title="Requests answered with HTTP 429, too many requests">
                Rate-limited
              </th>
              <th className="num" title="Requests the client closed before the answer finished, HTTP 499">
                Cancelled
              </th>
              <th className="num" title="Requests that failed on Anthropic's side, HTTP 5xx">
                Server errors
              </th>
            </tr>
          </thead>
          <tbody>
            {v.byAccountModel.length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  No requests in this range.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={`${r.account}:${r.model}`}>
                <td>
                  <span className="swatch small" style={{ background: props.colors.get(r.account) }} aria-hidden /> {emails.get(r.account) ?? r.account}
                </td>
                <td title={r.model}>{modelName(r.model)}</td>
                <td className="num">{r.stats.requests.toLocaleString()}</td>
                <td className="num">{compact(r.stats.tokens.output)}</td>
                <td className="num">{share(r.stats.cacheReadShare)}</td>
                <td className="num">{seconds(r.stats.ttftMs?.p50 ?? null)}</td>
                <td className="num">{seconds(r.stats.latencyMs?.p50 ?? null)}</td>
                <td className="num">{r.stats.outcomes.rate_limited}</td>
                <td className="num">{r.stats.outcomes.client_closed}</td>
                <td className="num">{r.stats.outcomes.server_error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {v.byAccountModel.length > ROWS_SHOWN && (
        <button type="button" className="btn small quiet more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${v.byAccountModel.length} rows`}
        </button>
      )}
    </section>
  );
}

const ERRORS_SHOWN = 6;

/** A cell that is null has nothing to say. A column whose every shown cell is null is left out, so a log with no quota reasons has no such column. */
interface ErrorColumn {
  readonly head: string;
  readonly className?: string;
  readonly cell: (e: ErrorEventView) => ReactNode | null;
  readonly title?: (e: ErrorEventView) => string | undefined;
}

const ERROR_COLUMNS: readonly ErrorColumn[] = [
  { head: 'When', cell: (e) => (e.at === null ? null : <Clock at={e.at} />) },
  { head: 'Account', cell: (e) => e.email ?? e.account },
  { head: 'Status', className: 'num', cell: (e) => e.status },
  { head: 'Quota reason', cell: (e) => (e.quotaReason === null ? null : reasonText(e.quotaReason)), title: (e) => e.quotaReason ?? undefined },
  { head: 'Recovers', cell: (e) => (e.recoverAt === null ? null : <Clock at={e.recoverAt} />) },
  { head: 'Message', className: 'message', cell: (e) => e.message || null, title: (e) => e.message },
];

export function ErrorsTable(props: { readonly view: AnalyticsView }) {
  const v = props.view;
  const shown = v.errors.slice(0, ERRORS_SHOWN);
  const columns = shown.length === 0 ? ERROR_COLUMNS : ERROR_COLUMNS.filter((c) => shown.some((e) => c.cell(e) !== null));
  return (
    <section className="card" aria-label="Recent errors and rate limits" data-testid="errors">
      <div className="card-head">
        <div className="card-title">
          <h2>Recent errors and rate limits</h2>
          <p>From CPA's error log · {RANGE_LABEL[v.lens.range].toLowerCase()}</p>
        </div>
      </div>
      <TableScroll label="Recent errors and rate limits">
        <table className="data errors">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.head} className={c.className}>
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted">
                  No errors in this range.
                </td>
              </tr>
            )}
            {shown.map((e) => (
              <tr key={e.id}>
                {columns.map((c) => (
                  <td key={c.head} className={c.className} title={c.title?.(e)}>
                    {c.cell(e) ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}
