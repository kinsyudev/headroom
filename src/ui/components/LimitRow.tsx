/**
 * One quota window, with the difference between sources made visible.
 *
 *   Session   ██████░░░░░░  17%   ↻ 2h 47m      live · 3s
 *                 ╵ poll 15% · 4m                  ← faint tick at `other.percent`, shown only when `other` exists
 *
 * - The bar fill colour comes from severity (normal / warning / critical).
 * - Source chip: `live` (headers) is drawn solid, `poll` outlined. The age comes from <Age at={source.at}>.
 * - rolled: the bar is hatched, the text reads "reset 2m ago, awaiting data", and the percent is hidden.
 * - isActive: a small "binding" marker on the limit Anthropic says is currently limiting.
 */
import type { LimitView, SpendView } from '../../shared/view';
import { Age, Countdown } from './Countdown';

export function LimitRow(props: { readonly limit: LimitView }) {
  void [Age, Countdown];
  throw new Error('not implemented');
}

/**
 * Spend         $0.00 / $100.00   0%                       poll · 4m
 *               overage live: 101% rejected (org_spend_cap_reached) · 3s   ← when `live` is set
 * When spend is disabled, show "off" plus the disabled reason.
 */
export function SpendRow(props: { readonly spend: SpendView | null }) {
  throw new Error('not implemented');
}
