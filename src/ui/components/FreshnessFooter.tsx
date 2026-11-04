/**
 * One chip per feed: "CPA 2s · headers 3s · limits 41s · resets 9m (rate-limited, retry 14:02) · profile 2h"
 *
 * Colours by FreshnessView.state: fresh = plain, aging = muted, stale = amber, failing = red with
 * the SourceError on hover, never = grey "—". `traffic` (headers) is always plain. Its age means
 * "last request", not "broken".
 * The footer is how the operator sees passive vs authoritative freshness side by side.
 */
import type { FreshnessView } from '../../shared/view';

export function FreshnessFooter(props: { readonly feeds: readonly FreshnessView[] }) {
  throw new Error('not implemented');
}
