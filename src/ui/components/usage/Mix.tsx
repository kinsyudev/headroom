import { useState } from 'react';
import type { AccountId, Effort } from '../../../shared/domain';
import type { AnalyticsView, Part } from '../../../shared/view';
import { compact, count, modelName, share } from '../../format';
import { BarList, type BarRow } from '../charts/BarList';
import { ChartCard } from '../charts/ChartCard';
import { Switch } from '../charts/Switch';
import { RANGE_LABEL } from './Toolbar';

type Measure = 'requests' | 'output';

const MEASURES: readonly { readonly key: Measure; readonly label: string; readonly title: string }[] = [
  { key: 'requests', label: 'Requests', title: 'Each row as a share of all requests' },
  { key: 'output', label: 'Output tokens', title: 'Each row as a share of all output tokens' },
];

/** Effort is ordered, so it takes the brand ramp from faint to bright. Unset and none are not on the ladder and stay gray. */
const EFFORT: Readonly<Record<string, { readonly label: string; readonly color: string }>> = {
  none: { label: 'None', color: 'var(--muted)' },
  low: { label: 'Low', color: 'var(--ice-2)' },
  medium: { label: 'Medium', color: 'var(--ice-3)' },
  high: { label: 'High', color: 'var(--ice-4)' },
  xhigh: { label: 'Extra high', color: 'var(--ice-5)' },
  max: { label: 'Max', color: 'var(--ice-6)' },
  '': { label: 'Not set', color: 'var(--muted)' },
};
const effort = (e: Effort) => EFFORT[e] ?? { label: e, color: 'var(--ice-3)' };

const NOMINAL = 'var(--ice-4)';

function rows<K extends string>(parts: readonly Part<K>[], measure: Measure, name: (k: K) => string, color: (k: K) => string, swatch = false): BarRow[] {
  return parts
    .filter((p) => p.stats.requests > 0)
    .map((p) => {
      const s = measure === 'requests' ? p.share?.requests ?? 0 : p.share?.output ?? 0;
      return {
        key: p.key,
        label: name(p.key),
        fill: s,
        text: share(s),
        color: color(p.key),
        swatch,
        tip: [
          { value: share(p.share?.requests ?? 0), label: 'of requests' },
          { value: count(p.stats.requests), label: 'requests' },
          { value: share(p.share?.output ?? 0), label: 'of output' },
          { value: compact(p.stats.tokens.output), label: 'output tokens' },
        ],
      };
    });
}

/** What you use: models, reasoning effort and accounts as shares. Picking a model or an account narrows every chart below the toolbar. */
export function Mix(props: {
  readonly view: AnalyticsView;
  readonly colors: ReadonlyMap<AccountId, string>;
  readonly account: AccountId | null;
  readonly model: string | null;
  readonly onAccount: (a: AccountId | null) => void;
  readonly onModel: (m: string | null) => void;
}) {
  const [measure, setMeasure] = useState<Measure>('requests');
  const v = props.view;
  const emails = new Map(v.dimensions.accounts.map((a) => [a.id, a.email]));
  const toggle = <T,>(current: T | null, set: (next: T | null) => void) => (key: string) => set(current === key ? null : (key as T));
  return (
    <ChartCard
      title="What you use"
      sub={`Share of ${measure === 'requests' ? 'requests' : 'output tokens'} · ${RANGE_LABEL[v.lens.range].toLowerCase()} · click a row to narrow the charts`}
      actions={<Switch label="Measure" options={MEASURES} value={measure} onChange={setMeasure} />}
      testId="mix"
    >
      <div className="mix">
        <div className="mix-col">
          <h3>Models</h3>
          <BarList label="Share by model" rows={rows(v.byModel, measure, modelName, () => NOMINAL)} selected={props.model} onSelect={toggle(props.model, props.onModel)} />
        </div>
        <div className="mix-col">
          <h3>Reasoning effort</h3>
          <BarList label="Share by reasoning effort" rows={rows(v.byEffort, measure, (e) => effort(e).label, (e) => effort(e).color)} />
        </div>
        <div className="mix-col">
          <h3>Accounts</h3>
          <BarList
            label="Share by account"
            rows={rows(v.byAccount, measure, (id) => (emails.get(id) ?? id).split('@')[0]!, (id) => props.colors.get(id) ?? NOMINAL, true)}
            selected={props.account}
            onSelect={toggle(props.account, props.onAccount)}
          />
        </div>
      </div>
    </ChartCard>
  );
}
