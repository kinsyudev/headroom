import { useMemo, useState } from 'react';
import type { AccountId, Outcome } from '../../../shared/domain';
import type { AnalyticsView } from '../../../shared/view';
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
              <th className="num" title="Requests answered with HTTP 429">
                429
              </th>
              <th className="num" title="Requests the client closed, HTTP 499">
                499
              </th>
              <th className="num" title="Server errors, HTTP 5xx">
                5xx
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

export function ErrorsTable(props: { readonly view: AnalyticsView }) {
  const v = props.view;
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
              <th>When</th>
              <th>Account</th>
              <th className="num">Status</th>
              <th>Quota reason</th>
              <th>Recovers</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {v.errors.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No errors in this range.
                </td>
              </tr>
            )}
            {v.errors.slice(0, 6).map((e) => (
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
    </section>
  );
}
