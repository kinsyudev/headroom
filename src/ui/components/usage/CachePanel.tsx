import { useMemo } from 'react';
import type { AnalyticsView } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, compact, count, share } from '../../format';
import { ChartCard, Legend } from '../charts/ChartCard';
import { Delta } from '../charts/Delta';
import { StackedColumns } from '../charts/StackedColumns';
import { RANGE_LABEL, RANGE_SPAN } from './Toolbar';

const DOMAIN = { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] } as const;
const PARTS = [
  { key: 'read', label: 'Read from cache', color: 'var(--ice-3)' },
  { key: 'write', label: 'Written to cache', color: 'var(--ice-5)' },
  { key: 'fresh', label: 'Not cached', color: 'var(--muted)' },
] as const;

/**
 * How much of the input Claude reads is served from cache. Each column is a whole: the three ways input arrives add to 100%, so the
 * scale starts at zero and the thin slice at the top is all there is left to win.
 */
export function CachePanel(props: { readonly view: AnalyticsView; readonly dim: boolean }) {
  const now = useNow();
  const v = props.view;
  const { label, title } = bucketText(v.lens.grain, now);
  const series = useMemo(
    () =>
      PARTS.map((p) => ({
        key: p.key,
        label: p.label,
        color: p.color,
        values: v.timeline.map((b) => {
          const t = b.total.tokens;
          const input = t.cacheRead + t.cacheCreation + t.freshInput;
          return input === 0 ? 0 : (p.key === 'read' ? t.cacheRead : p.key === 'write' ? t.cacheCreation : t.freshInput) / input;
        }),
      })),
    [v.timeline],
  );
  const cur = v.total.cacheReadShare;
  const prev = v.previous?.stats.cacheReadShare ?? null;
  const pts = cur !== null && prev !== null ? (cur - prev) * 100 : null;
  const table = useMemo(
    () => ({
      head: [v.lens.grain === 'hour' ? 'Hour' : 'Day', 'Read', 'Written', 'Not cached', 'Input tokens'],
      rows: v.timeline.map((b, i) => {
        const t = b.total.tokens;
        return [
          bucketText(v.lens.grain, now).span(b),
          ...series.map((s) => (b.total.cacheReadShare === null ? '—' : share(s.values[i] ?? 0))),
          compact(t.cacheRead + t.cacheCreation + t.freshInput),
        ];
      }),
    }),
    [series, v.timeline, now],
  );
  const t = v.total;
  return (
    <ChartCard
      title="Cache"
      sub={`Where the input came from · ${RANGE_LABEL[v.lens.range].toLowerCase()}`}
      legend={<Legend items={PARTS.map((p) => ({ key: p.key, label: p.label, color: p.color }))} />}
      table={table}
      testId="cache"
    >
      <div className="figures stacked">
        <div>
          <p className="figure">{share(t.cacheReadShare)}</p>
          <p className="figure-label">of input served from cache</p>
          <Delta change={pts === null ? null : pts / 100} text={`${Math.abs(pts ?? 0).toFixed(1)} pt`} better="up" flatBelow={0.0005} span={RANGE_SPAN[v.lens.range]} />
        </div>
        <div>
          <p className="figure">{t.outputPerRequest === null ? '—' : count(t.outputPerRequest)}</p>
          <p className="figure-label">output tokens per request</p>
        </div>
        <div>
          <p className="figure">{t.outputPerSession === null ? '—' : compact(t.outputPerSession)}</p>
          <p className="figure-label">output tokens per session</p>
        </div>
      </div>
      <StackedColumns
        buckets={v.timeline}
        series={series}
        format={(n) => share(n)}
        bucketLabel={label}
        tooltipTitle={title}
        label="Share of input tokens by how they arrived, per bucket"
        dim={props.dim}
        domain={DOMAIN}
        ceiling="all of the input"
        hideTotal
        height={210}
      />
    </ChartCard>
  );
}
