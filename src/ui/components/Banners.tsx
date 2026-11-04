/**
 * Page-level problems, at most one line each, most severe first:
 *   link rejected  "CPA rejected the management key. The deck has stopped all management calls to
 *                   avoid CPA's IP ban. Fix CPA_MANAGEMENT_KEY in /opt/homebrew/etc/cpa-usage-keeper.env;
 *                   the deck retries once when the file changes."
 *   link guarded   "Auth-failure budget spent; next attempt at 14:31."
 *   missing_key    "No CPA_MANAGEMENT_KEY in <envPath>."
 *   cpa_unreachable "CPA not answering for 2m; data below is from <Age>."
 *   claim_in_doubt "A cedar_ember claim on account3 may have been sent before a restart. Checking; it won't be resent."
 *   SSE lost       "Disconnected from the deck server; reconnecting. Ages keep counting."
 */
import type { Banner } from '../../shared/view';
import type { Connection } from '../api';

export function Banners(props: { readonly banners: readonly Banner[]; readonly connection: Connection }) {
  throw new Error('not implemented');
}
