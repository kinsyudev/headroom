/**
 * The "is a Claude reset available?" block on each card. One row per program; cedar rows list grants.
 *
 *   juniper_tide   CLAIMABLE                                           [Claim…]
 *   juniper_tide   waiting → Thu 09:00 (<Countdown>)
 *   juniper_tide   held: checked at the wall
 *   juniper_tide   ineligible: tenure (Account is too new.)
 *   cedar_ember    CLAIMABLE · "Launch grant" 2/3 left · clears five_hour · ends Nov 30   [Claim…]
 *                  "Weekly grant" 0/1 left (exhausted)
 *   cedar_ember    claim in doubt: checking on next poll                 (in_flight, doubt)
 *   …              unknown: rate-limited, retry 14:02                   (from the programs FreshnessView)
 *
 * [Claim…] opens <ClaimDialog>, which runs claim.prepare and then claim.confirm.
 */
import type { AccountView, OfferView } from '../../shared/view';
import { ClaimDialog } from './ClaimDialog';

export function ResetOffers(props: { readonly account: AccountView }) {
  void ClaimDialog;
  throw new Error('not implemented');
}

export function OfferRow(props: { readonly offer: OfferView; readonly onClaim: () => void }) {
  throw new Error('not implemented');
}
