import { useMemo } from 'react';
import type { TokenSums } from '../../../shared/domain';
import type { AnalyticsView } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, compact, share } from '../../format';
import { ChartCard } from '../charts/ChartCard';
import { StackedColumns } from '../charts/StackedColumns';
import { niceTicks } from '../charts/kit';
import { RANGE_LABEL } from './Toolbar';

const MISSED = 'var(--ice-4)';
const MIN_TOP = 0.1;

const inputOf = (t: TokenSums) => t.freshInput + t.cacheRead + t.cacheCreation;

/**
 * What missed the cache: the share of input written plus not cached, per bucket. It states no number of its own, because the hit rate
 * is the Usage tile's and the exact miss is in each bar's tooltip. The miss is a few percent, so it is drawn on a zoomed scale that
 * starts at zero and opens at 10%, and the subtitle names that scale so the short bars are not read against 100%. It grows only
 * when a bucket misses more than that.
 */
export function CachePanel(props: { readonly view: AnalyticsView; readonly dim: boolean }) {
  const now = useNow();
  const v = props.view;
  const { label, span, title } = bucketText(v.lens.grain, now);
  const misses = useMemo(() => v.timeline.map((b) => b.total.cacheMissShare ?? 0), [v.timeline]);
  const domain = useMemo(() => {
    const ticks = niceTicks(Math.max(MIN_TOP, ...misses));
    return { max: ticks.at(-1)!, ticks };
  }, [misses]);
  const tickDigits = domain.ticks.some((t) => Math.abs(t * 100 - Math.round(t * 100)) > 1e-6) ? 1 : 0;
  const series = useMemo(() => [{ key: 'missed', label: 'Missed the cache', color: MISSED, values: misses }], [misses]);
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Missed the cache', 'Served from cache', 'Input tokens'],
      rows: v.timeline.map((b) => [span(b), share(b.total.cacheMissShare), share(b.total.cacheReadShare), compact(inputOf(b.total.tokens))]),
    }),
    [v.timeline, now],
  );
  return (
    <ChartCard
      title={`Cache misses by ${v.lens.grain}`}
      sub={`${RANGE_LABEL[v.lens.range]} · share of input · scale 0 to ${share(domain.max)}`}
      table={table}
      testId="cache"
    >
      <StackedColumns
        buckets={v.timeline}
        series={series}
        format={(n) => share(n)}
        tickFormat={(n) => share(n, tickDigits)}
        bucketLabel={label}
        tooltipTitle={title}
        label={`Share of input tokens that missed the cache per ${v.lens.grain}, on a scale from 0 to ${share(domain.max)}`}
        dim={props.dim}
        domain={domain}
        hideTotal
        height={250}
        fill
        extra={(i) => (
          <div className="tooltip-row total">
            <strong className="num">{compact(inputOf(v.timeline[i]!.total.tokens))}</strong>
            <span className="muted">input tokens</span>
          </div>
        )}
      />
    </ChartCard>
  );
}
