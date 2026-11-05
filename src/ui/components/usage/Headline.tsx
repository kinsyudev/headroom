import { useMemo } from 'react';
import type { AccountId } from '../../../shared/domain';
import type { AnalyticsView, Part, UsageStats, WeekGrid } from '../../../shared/view';
import { useNow } from '../../deck';
import { bucketText, changeText, compact, count, hourText, modelName, share, weekdayName } from '../../format';
import { Age } from '../Countdown';
import { Blocks, type Block } from '../charts/Blocks';
import { Delta } from '../charts/Delta';
import { RANGE_LABEL, RANGE_SPAN } from './Toolbar';

const change = (now: number, before: number | undefined): number | null => (before === undefined || before === 0 ? null : (now - before) / before);

/**
 * The selected range against the span before it, so the numbers here are the ones the charts below add up to. It answers how much,
 * whether that is more or less than before, what carried it, and when it happens, with a figure and its context in each tile.
 * The busiest weekday needs a month of weeks, so it reads from the pattern lens and says so.
 */
export function Headline(props: { readonly view: AnalyticsView; readonly week: WeekGrid; readonly colors: ReadonlyMap<AccountId, string>; readonly emailOf: (id: AccountId) => string }) {
  const now = useNow();
  const v = props.view;
  const span = RANGE_SPAN[v.lens.range];
  const prev = v.previous?.stats ?? null;
  const prior = useMemo(() => v.timeline.flatMap((b) => (b.previous ? [b.previous] : [])), [v.timeline]);
  const { span: describe } = bucketText(v.lens.grain, now);
  const blocks = (pick: (s: UsageStats) => number): Block[] => [
    ...prior.map((p) => ({ start: p.start, end: p.end, value: pick(p.stats) })),
    ...v.timeline.map((b) => ({ start: b.start, end: b.end, value: pick(b.total) })),
  ];
  const requests = useMemo(() => blocks((s) => s.requests), [v.timeline, prior]);
  const output = useMemo(() => blocks((s) => s.tokens.output), [v.timeline, prior]);
  const describeBlock = (b: Block) => describe({ ...b, partial: false });

  const t = v.total;
  const topModel = v.byModel[0];
  const topAccount = v.byAccount.reduce<Part<AccountId> | undefined>((best, p) => (p.stats.requests > (best?.stats.requests ?? 0) ? p : best), undefined);
  const cachePts = prev && t.cacheReadShare !== null && prev.cacheReadShare !== null ? (t.cacheReadShare - prev.cacheReadShare) * 100 : null;

  return (
    <section className="card flush" aria-label={RANGE_LABEL[v.lens.range]} data-testid="week-strip">
      <div className="card-head padded">
        <div className="card-title">
          <h2>{RANGE_LABEL[v.lens.range]}</h2>
          <p>{v.previous ? `Compared with the ${span} before, the dim bars` : `One bar per ${v.lens.grain} · the history holds no earlier ${span}`}</p>
        </div>
        <p className="card-note muted">
          {v.keeperLatestAt !== null && (
            <>
              Latest request <Age at={v.keeperLatestAt} /> ago
            </>
          )}
          {v.catchingUp && ' · still reading the request log'}
        </p>
      </div>
      <div className="kpis">
        <div className="kpi" data-testid="kpi-requests">
          <h3>Requests</h3>
          <p className="kpi-value">{count(t.requests)}</p>
          <Delta change={change(t.requests, prev?.requests)} text={changeText(change(t.requests, prev?.requests))} span={span} />
          <Blocks blocks={requests} split={prior.length} format={count} describe={describeBlock} unit="requests" label={`Requests per ${v.lens.grain}, the earlier span then the latest`} />
        </div>
        <div className="kpi" data-testid="kpi-output">
          <h3>Output tokens</h3>
          <p className="kpi-value">{compact(t.tokens.output)}</p>
          <Delta change={change(t.tokens.output, prev?.tokens.output)} text={changeText(change(t.tokens.output, prev?.tokens.output))} span={span} />
          <Blocks blocks={output} split={prior.length} format={compact} describe={describeBlock} unit="output tokens" label={`Output tokens per ${v.lens.grain}, the earlier span then the latest`} />
        </div>
        <div className="kpi" data-testid="kpi-cache">
          <h3>Cache hit</h3>
          <p className="kpi-value">{share(t.cacheReadShare)}</p>
          <Delta change={cachePts === null ? null : cachePts / 100} text={`${Math.abs(cachePts ?? 0).toFixed(1)} pt`} better="up" flatBelow={0.0005} span={span} />
          <div className="ceilbar" role="meter" aria-label="Share of input served from cache" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((t.cacheReadShare ?? 0) * 100)}>
            <span className="ceilbar-fill" style={{ width: `${(t.cacheReadShare ?? 0) * 100}%` }} />
          </div>
          <p className="kpi-sub">of the input Claude read came from cache</p>
        </div>
        <div className="kpi" data-testid="kpi-top">
          <h3>Most used</h3>
          <p className="kpi-value kpi-text">{topModel ? modelName(topModel.key) : '—'}</p>
          <p className="kpi-sub">{topModel?.share ? `${share(topModel.share.requests)} of requests · ${share(topModel.share.output)} of output` : 'No requests'}</p>
          {topAccount && (
            <p className="kpi-line">
              <span className="swatch small" style={{ background: props.colors.get(topAccount.key) }} aria-hidden />
              <strong>{props.emailOf(topAccount.key).split('@')[0]}</strong>
              <span className="muted">{share(topAccount.share?.requests ?? null)} of requests</span>
            </p>
          )}
        </div>
        <div className="kpi" data-testid="kpi-busiest">
          <h3>Busiest</h3>
          {props.week.peak ? (
            <>
              <p className="kpi-value kpi-text">{weekdayName(props.week.peak.weekday)}s</p>
              <p className="kpi-sub">
                heaviest hours {hourText(props.week.peak.hours.from)}–{hourText(props.week.peak.hours.to)}
              </p>
              <p className="kpi-line muted">a usual week, last 30 days</p>
            </>
          ) : (
            <p className="kpi-value kpi-text muted">—</p>
          )}
        </div>
      </div>
    </section>
  );
}
