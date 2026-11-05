import { useMemo } from 'react';
import type { AccountId } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { useAnalytics } from '../api';
import { useNow } from '../deck';
import { bucketText, compact, count } from '../format';
import { Age } from './Countdown';
import { Legend } from './charts/ChartCard';
import { StackedColumns } from './charts/StackedColumns';
import { Segments } from './Segments';

/** The last 24 hours of requests by account, at a glance. Ranges, other measures, the table and the rest are in Usage. */
export function HistoryPanel(props: { readonly accounts: readonly AccountView[]; readonly colors: ReadonlyMap<AccountId, string> }) {
  const state = useAnalytics({ range: '24h' }, props.accounts);
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
            values: usage.timeline.map((b) => b.byAccount[j]!.stats.requests),
          }))
        : [],
    // usage changes identity every second; its timeline does not
    [timeline, props.colors],
  );
  const limited = (i: number) => usage?.timeline[i]?.total.outcomes.rate_limited ?? 0;
  const { label, title } = bucketText('hour', now);
  const total = usage?.total;
  const failed = total ? total.requests - total.outcomes.ok : 0;

  return (
    <section className="panel history" aria-label="Activity" data-testid="history">
      <div className="panel-head">
        <h2>
          Activity <span className="panel-sub">last 24 hours, per hour</span>
        </h2>
        <a className="jump panel-link" href="#usage">
          Open Usage →
        </a>
      </div>
      {error && <p className="banner warning">History unavailable: {error}</p>}
      {(usage || loading) && (
        <div className="legend">
          <span className="muted">
            <Segments
              parts={[
                total && <>{count(total.requests)} requests in 24h</>,
                failed > 0 && <>{count(failed)} failed</>,
                usage?.keeperLatestAt && (
                  <>
                    latest <Age at={usage.keeperLatestAt} /> ago
                  </>
                ),
                loading && 'loading',
              ]}
            />
          </span>
          {series.length > 0 && <Legend items={series.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />}
        </div>
      )}
      {usage && (
        <StackedColumns
          buckets={usage.timeline}
          series={series}
          format={compact}
          bucketLabel={label}
          tooltipTitle={title}
          label="Requests per hour by account, last 24 hours"
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
    </section>
  );
}
