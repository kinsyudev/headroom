import { useMemo } from 'react';
import type { TokenSums } from '../../../shared/domain';
import type { AnalyticsView } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, compact, share } from '../../format';
import { ChartCard } from '../charts/ChartCard';
import { Delta } from '../charts/Delta';
import { StackedColumns } from '../charts/StackedColumns';
import { niceTicks } from '../charts/kit';
import { RANGE_LABEL, RANGE_SPAN } from './Toolbar';

const MISSED = 'var(--ice-4)';
const MIN_TOP = 0.1;

const inputOf = (t: TokenSums) => t.freshInput + t.cacheRead + t.cacheCreation;

/**
 * How well the cache works: the share served from it as the headline, and under it the share that missed it, written plus not
 * cached, per bucket. The miss is a few percent, so it is drawn on a zoomed scale that starts at zero and opens at 10%, and the
 * subtitle names that scale so the short bars are not read against 100%. It grows only when a bucket misses more than that.
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
  const series = useMemo(() => [{ key: 'missed', label: 'Missed the cache', color: MISSED, values: misses }], [misses]);
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Served from cache', 'Missed the cache', 'Input tokens'],
      rows: v.timeline.map((b) => [span(b), share(b.total.cacheReadShare), share(b.total.cacheMissShare), compact(inputOf(b.total.tokens))]),
    }),
    [v.timeline, now],
  );
  const cur = v.total.cacheReadShare;
  const prev = v.previous?.stats.cacheReadShare ?? null;
  const pts = cur !== null && prev !== null ? (cur - prev) * 100 : null;
  return (
    <ChartCard
      title="Cache"
      sub={`Missed the cache · ${RANGE_LABEL[v.lens.range].toLowerCase()} · scale 0 to ${share(domain.max)}`}
      table={table}
      testId="cache"
    >
      <div className="figures">
        <div>
          <p className="figure">{share(cur)}</p>
          <p className="figure-label">of input served from cache</p>
          <Delta change={pts === null ? null : pts / 100} text={`${Math.abs(pts ?? 0).toFixed(1)} pt`} better="up" flatBelow={0.0005} span={RANGE_SPAN[v.lens.range]} />
        </div>
      </div>
      <StackedColumns
        buckets={v.timeline}
        series={series}
        format={(n) => share(n)}
        bucketLabel={label}
        tooltipTitle={title}
        label={`Share of input tokens that missed the cache per ${v.lens.grain}, on a scale from 0 to ${share(domain.max)}`}
        dim={props.dim}
        domain={domain}
        hideTotal
        height={250}
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
