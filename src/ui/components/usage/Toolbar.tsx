import type { AccountId } from '../../../shared/domain';
import { USAGE_RANGES, type AccountView, type UsageRange } from '../../../shared/view';
import { modelName, shortName } from '../../format';
import { Switch } from '../charts/Switch';
import { Swatch, type Slot } from '../Swatch';

const ALL = 'all';
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const RANGE_LABEL: Readonly<Record<UsageRange, string>> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };

/** How long a range is, as the span it is compared with: "the 7 days before". */
export const RANGE_SPAN: Readonly<Record<UsageRange, string>> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

/** The one row of filters. Everything below it is drawn from what it picks. The quota pace sits above it, because no filter changes it. */
export function Toolbar(props: {
  readonly range: UsageRange;
  readonly onRange: (r: UsageRange) => void;
  readonly account: AccountId | null;
  readonly onAccount: (a: AccountId | null) => void;
  readonly model: string | null;
  readonly onModel: (m: string | null) => void;
  readonly accounts: readonly AccountView[];
  readonly slots: ReadonlyMap<AccountId, Slot>;
  readonly models: readonly string[];
}) {
  return (
    <div className="toolbar" role="group" aria-label="Filters for the charts below">
      <h2 className="toolbar-title">Explore</h2>
      <Switch label="Range" options={USAGE_RANGES.map((r) => ({ key: r, label: r, title: RANGE_LABEL[r] }))} value={props.range} onChange={props.onRange} testId={(r) => `usage-range-${r}`} />
      <div className="field">
        <span className="field-label">Account</span>
        <Switch
          label="Account"
          options={[
            { key: ALL, label: 'All' },
            ...props.accounts.map((a) => ({
              key: a.id as string,
              title: a.email,
              label: (
                <>
                  <Swatch slot={props.slots.get(a.id)} /> {shortName(a.email)}
                </>
              ),
            })),
          ]}
          value={props.account ?? ALL}
          onChange={(k) => props.onAccount(k === ALL ? null : (k as AccountId))}
        />
      </div>
      <label className="field">
        <span className="field-label">Model</span>
        <select className="select" value={props.model ?? ALL} onChange={(e) => props.onModel(e.target.value === ALL ? null : e.target.value)} data-testid="usage-model">
          <option value={ALL}>All models</option>
          {props.models.map((m) => (
            <option key={m} value={m}>
              {modelName(m)}
            </option>
          ))}
        </select>
      </label>
      <span className="toolbar-note muted">Local time, {TIME_ZONE}</span>
    </div>
  );
}
