/**
 * The at-a-glance row.
 *
 *  SERVING account1 (fill-first target)   also: account2 (affinity, 41s ago)
 *    · when nobody served in the last 2 min: "idle; next request → account1"
 *  Session headroom 1.3 / 3   Weekly headroom 1.7 / 3   (+1 unknown)
 *  Next reset: account3 session in <Countdown>     Next unblock: account3 at 15:20
 *  Claimable: account3 · cedar_ember "Launch grant" [Claim…]  (opens the same ClaimDialog as the card)
 *  Routing: [fill-first | round-robin]   ← useAction('routing.setStrategy'); confirm() before switching
 *  [+ Add account]                       ← see AddAccountDialog for the popup-blocker dance
 *  [↻ Refresh all]                       ← useAction('quota.refresh') with { account: 'all' }
 */
import type { DeckView } from '../../shared/view';

export function OverviewStrip(props: { readonly deck: DeckView }) {
  throw new Error('not implemented');
}
