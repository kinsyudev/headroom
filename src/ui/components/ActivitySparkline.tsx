/**
 * 20 bars × 10 min from CPA's recent_requests (about 3 h 20 m). Success is the bar; failed is a red
 * cap on top. Hovering a bar shows the local time range and counts. Plain SVG, no chart library.
 */
import type { AccountView } from '../../shared/view';

export function ActivitySparkline(props: { readonly buckets: AccountView['activity'] }) {
  throw new Error('not implemented');
}
