import { useMemo, useState, type ReactNode } from 'react';
import type { AccountId, Outcome } from '../../../shared/domain';
import type { AnalyticsView, ErrorEventView } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, compact, count, modelName, reasonText, seconds, share, shortName, stamp } from '../../format';
import { TableScroll } from '../TableScroll';
import { ChartCard, Legend } from '../charts/ChartCard';
import { StackedColumns } from '../charts/StackedColumns';
import { RANGE_LABEL } from './Toolbar';

type Failed = Exclude<Outcome, 'ok'>;

interface Failure {
  readonly outcome: Failed;
  /** The legend leads with the plain word. The status code stays in tooltips and table headers. */
  readonly status: string;
  readonly word: string;
  readonly short: string;
  readonly column: string;
  readonly hint: string;
  readonly icon: string;
  readonly color: string;
  /** Not named in the table and left out of the legend while nothing of it happened. */
  readonly rare?: true;
}

/**
 * A failure is a status, so it wears the status colours and a glyph: 429 amber, 5xx red. A 499 is the client hanging up, not a fault, so it
 * stays gray, and anything else is neutral.
 */
const FAILURES: readonly Failure[] = [
  { outcome: 'rate_limited', status: '429', word: 'rate-limited', short: 'rate-limited', column: 'Rate-limited', hint: 'Requests answered with HTTP 429, too many requests', icon: '!', color: 'var(--warning)' },
  { outcome: 'server_error', status: '5xx', word: 'server error', short: 'server errors', column: 'Server errors', hint: "Requests that failed on Anthropic's side, HTTP 5xx", icon: '✕', color: 'var(--critical)' },
  { outcome: 'client_closed', status: '499', word: 'cancelled', short: 'cancelled', column: 'Cancelled', hint: 'Requests the client closed before the answer finished, HTTP 499', icon: '○', color: 'var(--quiet)' },
  { outcome: 'other_error', status: '', word: 'other', short: 'other', column: 'Other', hint: 'Requests that failed some other way', icon: '·', color: 'var(--axis)', rare: true },
];
const NAMED = FAILURES.filter((f) => !f.rare);
const withStatus = (f: Failure): string => (f.status === '' ? f.word : `${f.status} ${f.word}`);

export function FailuresPanel(props: { readonly view: AnalyticsView; readonly dim: boolean }) {
  const now = useNow();
  const v = props.view;
  const t = v.total;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const otherHappened = t.outcomes.other_error > 0;
  const shown = FAILURES.filter((f) => !f.rare || otherHappened);
  const series = useMemo(
    () => shown.map((f) => ({ key: f.outcome, label: withStatus(f), color: f.color, values: v.timeline.map((b) => b.total.outcomes[f.outcome]) })),
    [v.timeline, otherHappened],
  );
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Requests', ...shown.map(withStatus)],
      rows: v.timeline.map((b) => [span(b), count(b.total.requests), ...shown.map((f) => b.total.outcomes[f.outcome])]),
    }),
    [v.timeline, otherHappened, now],
  );
  const failed = t.requests - t.outcomes.ok;
  return (
    <ChartCard
      title="Failures"
      sub={`Requests that did not succeed · ${RANGE_LABEL[v.lens.range].toLowerCase()}`}
      legend={<Legend items={shown.map((f) => ({ key: f.outcome, label: f.word, color: f.color, icon: f.icon }))} />}
      table={table}
      testId="failures"
    >
      <div className="figures">
        <div>
          <p className="figure">{share(t.rates === null ? null : t.rates.ok)}</p>
          <p className="figure-label">of {count(t.requests)} succeeded</p>
        </div>
        {NAMED.map((f) => (
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

/** The failures of one row in one cell, for a table too narrow for a column each: the glyph and count of each kind that happened, the split in the tooltip. */
function FailedCell(props: { readonly outcomes: Readonly<Record<Outcome, number>> }) {
  const split = NAMED.map((f) => `${props.outcomes[f.outcome]} ${f.short}`).join(', ');
  const happened = NAMED.filter((f) => props.outcomes[f.outcome] > 0);
  return (
    <span role="img" aria-label={split} title={split}>
      {happened.length === 0
        ? '0'
        : happened.map((f) => (
            <span key={f.outcome} className="fail-part">
              <span aria-hidden>{f.icon}</span> {props.outcomes[f.outcome]}
            </span>
          ))}
    </span>
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
      <TableScroll label="Totals by account and model" stickyFirst>
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
              {NAMED.map((f) => (
                <th key={f.outcome} className="num fail-split" title={f.hint}>
                  {f.column}
                </th>
              ))}
              <th className="num fail-merged" title={`Requests that did not succeed: ${NAMED.map((f) => `${f.short} (${f.status})`).join(', ')}`}>
                Failed
              </th>
            </tr>
          </thead>
          <tbody>
            {v.byAccountModel.length === 0 && (
              <tr>
                <td colSpan={7 + NAMED.length + 1} className="muted">
                  No requests in this range.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={`${r.account}:${r.model}`}>
                <td>
                  <span className="swatch small" style={{ background: props.colors.get(r.account) }} aria-hidden /> {shortName(emails.get(r.account) ?? r.account)}
                </td>
                <td title={r.model}>{modelName(r.model)}</td>
                <td className="num">{r.stats.requests.toLocaleString()}</td>
                <td className="num">{compact(r.stats.tokens.output)}</td>
                <td className="num">{share(r.stats.cacheReadShare)}</td>
                <td className="num">{seconds(r.stats.ttftMs?.p50 ?? null)}</td>
                <td className="num">{seconds(r.stats.latencyMs?.p50 ?? null)}</td>
                {NAMED.map((f) => (
                  <td key={f.outcome} className="num fail-split">
                    {r.stats.outcomes[f.outcome]}
                  </td>
                ))}
                <td className="num fail-merged">
                  <FailedCell outcomes={r.stats.outcomes} />
                </td>
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

function Stamp(props: { readonly at: number }) {
  return (
    <time className="num" dateTime={new Date(props.at).toISOString()} title={new Date(props.at).toLocaleString()}>
      {stamp(props.at)}
    </time>
  );
}

const errorColumns = (colors: ReadonlyMap<AccountId, string>): readonly ErrorColumn[] => [
  { head: 'When', cell: (e) => (e.at === null ? null : <Stamp at={e.at} />) },
  {
    head: 'Account',
    cell: (e) => {
      const name = e.email === null ? e.account : shortName(e.email);
      if (name === null) return null;
      return (
        <>
          <span className="swatch small" style={{ background: e.account === null ? undefined : colors.get(e.account) }} aria-hidden /> {name}
        </>
      );
    },
  },
  { head: 'Status', className: 'num', cell: (e) => e.status },
  { head: 'Quota reason', cell: (e) => (e.quotaReason === null ? null : reasonText(e.quotaReason)), title: (e) => e.quotaReason ?? undefined },
  { head: 'Recovers', cell: (e) => (e.recoverAt === null ? null : <Stamp at={e.recoverAt} />) },
  { head: 'Message', className: 'message', cell: (e) => e.message || null, title: (e) => e.message },
];

export function ErrorsTable(props: { readonly view: AnalyticsView; readonly colors: ReadonlyMap<AccountId, string> }) {
  const v = props.view;
  const shown = v.errors.slice(0, ERRORS_SHOWN);
  const all = errorColumns(props.colors);
  const columns = shown.length === 0 ? all : all.filter((c) => shown.some((e) => c.cell(e) !== null));
  return (
    <section className="card" aria-label="Recent errors and rate limits" data-testid="errors">
      <div className="card-head">
        <div className="card-title">
          <h2>Recent errors and rate limits</h2>
          <p>From CPA's error log · {RANGE_LABEL[v.lens.range].toLowerCase()}</p>
        </div>
      </div>
      <TableScroll label="Recent errors and rate limits" stickyFirst>
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
