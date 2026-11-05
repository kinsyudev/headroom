import { useMemo } from 'react';
import type { AccountId } from '../../../shared/domain';
import type { AnalyticsView, UsageStats } from '../../../shared/view';
import { useNow } from '../../deck';
import { changeText, clockTime, compact, count, hourText, modelName, share, weekdayName } from '../../format';
import { Age } from '../Countdown';
import { Blocks, type Block } from '../charts/Blocks';
import { Delta } from '../charts/Delta';

const VS = 'vs the 7 days before';

const change = (now: number, before: number | undefined): number | null => (before === undefined || before === 0 ? null : (now - before) / before);

/**
 * The last seven days against the seven before them. It answers how much, whether that is more or less than last week,
 * what carried it, and when it happens, with a figure and its context in each tile.
 */
export function WeekStrip(props: { readonly view: AnalyticsView; readonly colors: ReadonlyMap<AccountId, string>; readonly emailOf: (id: AccountId) => string }) {
  const now = useNow();
  const { weeks, week } = props.view;
  const cur = weeks.now.figures;
  const prev = weeks.before?.figures ?? null;
  const blocks = (pick: (s: UsageStats) => number): Block[] => weeks.blocks.map((b) => ({ start: b.start, end: b.end, value: pick(b.stats) }));
  const describe = (b: Block) => `${clockTime(b.start, now)} to ${clockTime(b.end, now)}`;
  const requests = useMemo(() => blocks((s) => s.requests), [weeks.blocks]);
  const output = useMemo(() => blocks((s) => s.tokens.output), [weeks.blocks]);

  const topModel = cur.byModel[0];
  const topAccount = cur.byAccount[0];
  const cachePts = prev && cur.stats.cacheReadShare !== null && prev.stats.cacheReadShare !== null ? (cur.stats.cacheReadShare - prev.stats.cacheReadShare) * 100 : null;

  return (
    <section className="card flush" aria-label="Last 7 days" data-testid="week-strip">
      <div className="card-head padded">
        <div className="card-title">
          <h2>Last 7 days</h2>
          <p>Compared with the 7 days before, the dim bars · whole hours up to {hourText(new Date(weeks.now.end).getHours())}</p>
        </div>
        <p className="card-note muted">
          {props.view.keeperLatestAt !== null && (
            <>
              Latest request <Age at={props.view.keeperLatestAt} /> ago
            </>
          )}
          {props.view.catchingUp && ' · still reading the request log'}
        </p>
      </div>
      <div className="kpis">
        <div className="kpi" data-testid="kpi-requests">
          <h3>Requests</h3>
          <p className="kpi-value num">{count(cur.stats.requests)}</p>
          <Delta change={change(cur.stats.requests, prev?.stats.requests)} text={changeText(change(cur.stats.requests, prev?.stats.requests))} vs={VS} />
          <Blocks blocks={requests} split={7} format={count} describe={describe} unit="requests" label="Requests per day, the earlier week then the latest" />
        </div>
        <div className="kpi" data-testid="kpi-output">
          <h3>Output tokens</h3>
          <p className="kpi-value num">{compact(cur.stats.tokens.output)}</p>
          <Delta change={change(cur.stats.tokens.output, prev?.stats.tokens.output)} text={changeText(change(cur.stats.tokens.output, prev?.stats.tokens.output))} vs={VS} />
          <Blocks blocks={output} split={7} format={compact} describe={describe} unit="output tokens" label="Output tokens per day, the earlier week then the latest" />
        </div>
        <div className="kpi" data-testid="kpi-cache">
          <h3>Cache hit</h3>
          <p className="kpi-value num">{share(cur.stats.cacheReadShare)}</p>
          <Delta
            change={cachePts === null ? null : cachePts / 100}
            text={`${Math.abs(cachePts ?? 0).toFixed(1)} pt`}
            better="up"
            flatBelow={0.0005}
            vs={VS}
          />
          <div className="ceilbar" role="meter" aria-label="Share of input served from cache" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((cur.stats.cacheReadShare ?? 0) * 100)}>
            <span className="ceilbar-fill" style={{ width: `${(cur.stats.cacheReadShare ?? 0) * 100}%` }} />
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
          {week.peak ? (
            <>
              <p className="kpi-value kpi-text">{weekdayName(week.peak.weekday)}s</p>
              <p className="kpi-sub">
                heaviest hours {hourText(week.peak.hours.from)}–{hourText(week.peak.hours.to)}
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
