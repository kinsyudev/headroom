/**
 * Add a Claude account through CPA's OAuth flow.
 *
 * Popup blockers allow window.open only inside the click handler, and the URL arrives after an
 * await. So:
 *   onClick: const tab = window.open('about:blank', '_blank');   // synchronous, inside the gesture
 *            const { url } = await act('oauth.start', {});
 *            if (tab) tab.location.href = url; else show the url as a link
 * The server polls CPA for status. This dialog only renders the flow from the snapshot:
 *   waiting  "Finish signing in in the other tab…" <Countdown to startedAt + 5 min>   [Cancel] → oauth.cancel
 *   ok       "Added account4@example.com". The new card is already in the grid.
 *   error    the error text                [Try again]
 *   expired  "Timed out after 5 minutes"   [Try again]
 */
import type { OAuthFlow } from '../../shared/domain';

export function AddAccountDialog(props: { readonly flows: readonly OAuthFlow[]; readonly emails: ReadonlyMap<string, string> }) {
  throw new Error('not implemented');
}
