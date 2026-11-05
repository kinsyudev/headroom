import { useMemo, useState } from 'react';
import type { AccountId } from '../../../shared/domain';
import type { AccountView, AnalyticsLens, UsageRange } from '../../../shared/view';
import { useAnalytics } from '../../api';
import { Mark } from '../../brand';
import { CachePanel } from './CachePanel';
import { Headline } from './Headline';
import { Mix } from './Mix';
import { OverTime } from './OverTime';
import { PacePanel } from './PacePanel';
import { ByModelTable, FailuresPanel } from './Reliability';
import type { Slot } from '../Swatch';
import { Speed } from './Speed';
import { Toolbar } from './Toolbar';
import { WeekPattern } from './WeekPattern';

/**
 * Usage opens on the quota pace, which neither the range nor the filters change, and then the toolbar and what it scopes: the
 * selected range against the span before it, and the history to explore. The headline and every chart below the toolbar read what it
 * picks, so one range holds the numbers together. It opens on the week, the span the dim bars and the same-day-last-week level marks
 * compare best. Three lenses read one cube. `all` is the month with no filters: it feeds the pace and the model list. `explore`
 * follows the toolbar. `pattern` is the month with the toolbar's account and model, because a weekly rhythm needs a month to show.
 */
export function Usage(props: { readonly accounts: readonly AccountView[]; readonly slots: ReadonlyMap<AccountId, Slot> }) {
  const [range, setRange] = useState<UsageRange>('7d');
  const [account, setAccount] = useState<AccountId | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const filters = useMemo((): Pick<AnalyticsLens, 'account' | 'model'> => ({ ...(account === null ? {} : { account }), ...(model === null ? {} : { model }) }), [account, model]);
  const all = useAnalytics({ range: '30d' }, props.accounts);
  const explore = useAnalytics({ range, ...filters }, props.accounts);
  const pattern = useAnalytics({ range: '30d', ...filters }, props.accounts);

  if (all.kind === 'loading' || explore.kind === 'loading' || pattern.kind === 'loading') {
    return (
      <section className="card empty" data-testid="analytics" aria-busy>
        <Mark size={36} />
        <p className="muted">Reading the request history…</p>
      </section>
    );
  }
  if (all.kind === 'failed' || explore.kind === 'failed' || pattern.kind === 'failed') {
    const error = all.kind === 'failed' ? all.error : explore.kind === 'failed' ? explore.error : pattern.kind === 'failed' ? pattern.error : '';
    return (
      <section className="card empty" data-testid="analytics">
        <p className="banner warning">Usage history is unavailable: {error}</p>
      </section>
    );
  }
  const a = all.view;
  const e = explore.view;
  const dim = explore.refreshing || e.catchingUp;
  const emailOf = (id: AccountId) => props.accounts.find((x) => x.id === id)?.email ?? id;

  return (
    <div className="usage" data-testid="analytics">
      {explore.error && <p className="banner warning">History could not be refreshed: {explore.error}. Showing the last reading.</p>}
      <PacePanel pace={a.pace} slots={props.slots} />
      <Toolbar
        range={range}
        onRange={setRange}
        account={account}
        onAccount={setAccount}
        model={model}
        onModel={setModel}
        accounts={props.accounts}
        slots={props.slots}
        models={a.dimensions.models}
      />
      <Headline view={e} week={pattern.view.week} slots={props.slots} emailOf={emailOf} />
      <OverTime view={e} slots={props.slots} dim={dim} />
      <div className="grid-2 pattern">
        <WeekPattern view={pattern.view} />
        <CachePanel view={e} dim={dim} />
      </div>
      <Mix view={e} slots={props.slots} account={account} model={model} onAccount={setAccount} onModel={setModel} />
      <div className="grid-2 reliability">
        <Speed view={e} />
        <FailuresPanel view={e} slots={props.slots} dim={dim} />
      </div>
      <ByModelTable view={e} slots={props.slots} />
    </div>
  );
}
