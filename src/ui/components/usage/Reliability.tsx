import { useMemo, useState } from 'react';
import type { AccountId, Outcome } from '../../../shared/domain';
import type { AnalyticsView, ErrorGroupView, ErrorLogView } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, clockTime, compact, count, modelName, reasonText, seconds, share, shortName } from '../../format';
import { Segments } from '../Segments';
import { Swatch, type Slot } from '../Swatch';
import { TableScroll } from '../TableScroll';
import { ChartCard, Legend } from '../charts/ChartCard';
import { StackedColumns } from '../charts/StackedColumns';
import { RANGE_LABEL } from './Toolbar';

type Failed = Exclude<Outcome, 'ok'>;

interface FailureKind {
  readonly outcome: Failed;
  /** The legend leads with the plain word. The status code stays in tooltips and table headers. */
  readonly status: string;
  readonly word: string;
  readonly short: string;
  readonly column: string;
  readonly hint: string;
  readonly icon: string;
  /** Not named in the table and left out of the legend while nothing of it happened. */
  readonly rare?: true;
}

/** A fault went wrong on the way and is drawn in its status colour. A cancelled request is the client hanging up, so it is counted and never drawn. */
type Failure = FailureKind & ({ readonly fault: true; readonly color: string } | { readonly fault: false });
type Fault = Extract<Failure, { fault: true }>;

/** A failure is a status, so it wears the status colours and a glyph: 429 amber, 5xx red. Anything else is neutral. */
const FAILURES: readonly Failure[] = [
  { outcome: 'rate_limited', status: '429', word: 'rate-limited', short: 'rate-limited', column: 'Rate-limited', hint: 'Requests answered with HTTP 429, too many requests', icon: '!', fault: true, color: 'var(--warning)' },
  { outcome: 'server_error', status: '5xx', word: 'server error', short: 'server errors', column: 'Server errors', hint: "Requests that failed on Anthropic's side, HTTP 5xx", icon: '✕', fault: true, color: 'var(--critical)' },
  { outcome: 'client_closed', status: '499', word: 'cancelled', short: 'cancelled', column: 'Cancelled', hint: 'Requests the client closed before the answer finished, HTTP 499', icon: '○', fault: false },
  { outcome: 'other_error', status: '', word: 'other', short: 'other', column: 'Other', hint: 'Requests that failed some other way', icon: '·', rare: true, fault: true, color: 'var(--axis)' },
];
const NAMED = FAILURES.filter((f) => !f.rare);
const ICON: Readonly<Record<Failed, string>> = Object.fromEntries(FAILURES.map((f) => [f.outcome, f.icon])) as Record<Failed, string>;
const withStatus = (f: Failure): string => (f.status === '' ? f.word : `${f.status} ${f.word}`);

export function FailuresPanel(props: { readonly view: AnalyticsView; readonly slots: ReadonlyMap<AccountId, Slot>; readonly dim: boolean }) {
  const now = useNow();
  const v = props.view;
  const t = v.total;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const otherHappened = t.outcomes.other_error > 0;
  const shown = FAILURES.filter((f) => !f.rare || otherHappened);
  const faults = shown.filter((f): f is Fault => f.fault);
  const series = useMemo(
    () => faults.map((f) => ({ key: f.outcome, label: withStatus(f), color: f.color, values: v.timeline.map((b) => b.total.outcomes[f.outcome]) })),
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
      legend={<Legend items={faults.map((f) => ({ key: f.outcome, label: f.word, color: f.color, icon: f.icon }))} />}
      table={table}
      footer={<ErrorLog log={v.errorLog} slots={props.slots} />}
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
              {f.short}
              {f.fault ? '' : ', not drawn'} · {share(t.rates?.[f.outcome] ?? null)}
            </p>
          </div>
        ))}
        {failed === 0 && <p className="muted">Nothing failed in this range.</p>}
      </div>
      <StackedColumns
        buckets={v.timeline}
        series={series}
        format={count}
        bucketLabel={label}
        tooltipTitle={title}
        label="Faults per bucket by kind, cancelled requests left out"
        dim={props.dim}
        height={170}
        extra={(i) => {
          const cancelled = v.timeline[i]!.total.outcomes.client_closed;
          return cancelled > 0 ? (
            <div className="tooltip-row">
              <span className="legend-icon" aria-hidden>
                {ICON.client_closed}
              </span>
              <strong className="num">{count(cancelled)}</strong>
              <span className="muted">cancelled, not in the total</span>
            </div>
          ) : null;
        }}
      />
    </ChartCard>
  );
}

const LOG_SHOWN = 3;

/** One line a run of the same error: "500 Internal server error ×5 · account2 · last 16:50", with its quota reason and recovery when CPA gave them. */
function logLine(g: ErrorGroupView, slots: ReadonlyMap<AccountId, Slot>, now: number) {
  const reason = g.quotaReason === null ? null : reasonText(g.quotaReason);
  const what = g.message || reason || 'No message';
  return [
    <>
      <span className="legend-icon" aria-hidden>
        {g.outcome === null || g.outcome === 'ok' ? '·' : ICON[g.outcome]}
      </span>{' '}
      <strong className="num">{g.status ?? '—'}</strong> {what}
      {g.count > 1 && <span className="num"> ×{g.count}</span>}
    </>,
    <>
      <Swatch slot={slots.get(g.account)} /> {g.email === null ? g.account : shortName(g.email)}
    </>,
    <>
      last{' '}
      <time className="num" dateTime={new Date(g.lastAt).toISOString()} title={new Date(g.lastAt).toLocaleString()}>
        {clockTime(g.lastAt, now)}
      </time>
    </>,
    g.message && reason ? reason : null,
    g.recoverAt === null ? null : <>recovers {clockTime(g.recoverAt, now)}</>,
  ];
}

/** CPA's error log inside Failures, a run of identical errors to a line, and how many of the failures it holds. */
function ErrorLog(props: { readonly log: ErrorLogView; readonly slots: ReadonlyMap<AccountId, Slot> }) {
  const now = useNow();
  const [all, setAll] = useState(false);
  const { groups, covered, faults } = props.log;
  if (faults === 0 && groups.length === 0) return null;
  const shown = all ? groups : groups.slice(0, LOG_SHOWN);
  return (
    <section className="fail-log" aria-label="Recent errors and rate limits" data-testid="errors">
      <div className="fail-log-head">
        <h3>CPA's error log</h3>
        <p className="fail-log-coverage muted">{faults === 0 ? 'No faults in this range' : `${covered} of ${faults} ${faults === 1 ? 'failure is' : 'failures are'} in CPA's log`}</p>
      </div>
      {groups.length > 0 && (
        <ul className="fail-lines">
          {shown.map((g) => (
            <li key={`${g.account}:${g.lastAt}`}>
              <Segments parts={logLine(g, props.slots, now)} />
            </li>
          ))}
        </ul>
      )}
      {groups.length > LOG_SHOWN && (
        <button type="button" className="btn small quiet more" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${groups.length} lines`}
        </button>
      )}
    </section>
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

export function ByModelTable(props: { readonly view: AnalyticsView; readonly slots: ReadonlyMap<AccountId, Slot> }) {
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
                  <Swatch slot={props.slots.get(r.account)} /> {shortName(emails.get(r.account) ?? r.account)}
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
