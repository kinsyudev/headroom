/**
 * The irreversible action. A modal that names exactly what will happen.
 *
 * Phases (local state, keyed by the ClaimRecord the server returns; the server holds the truth):
 *   preparing   act('claim.prepare', { account, program, grant })   → spinner "Checking availability…"
 *   ready       shows:
 *                 Account   account3@example.com (Team · Max 5x)
 *                 Program   cedar_ember, grant "Launch grant"
 *                 Clears    five_hour            Resets left after: 1 of 3
 *                 Based on  reset data from 41s ago   ← preflight.programsAt; amber if older than 2 min
 *                 This cannot be undone.
 *               [Cancel]   [Reset session limit on account3@example.com]   ← the label names account and program
 *   sending     the confirm button is disabled at once (useAction pending); act('claim.confirm', { claim, account, program })
 *   settled     result text per outcome:
 *                 reset            "Reset. five_hour cleared. 1 left. CPA cooldown cleared."  (followup done)
 *                 already_used     "Already used this week. Next: Thu 09:00."
 *                 not_limited      "Account wasn't limited; nothing consumed."
 *                 rate_limited     "Anthropic rate-limited the request; nothing consumed. Try again later."
 *                 not_sent         "Not sent: <why>. Nothing consumed."
 *   in_doubt    "The request may have reached Anthropic. The deck will check on the next poll and
 *                won't resend." (Banner stays until it's resolved.)
 *   expired     "This confirmation expired. Check again?" → re-prepare
 *
 * Errors from prepare (not_claimable, claim_conflict) render in place of the summary with the server's message.
 * Closing the dialog while it's sending doesn't cancel anything. The result arrives via the snapshot's claims[].
 */
import type { GrantId, ProgramId } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { useAction } from '../api';

export function ClaimDialog(props: {
  readonly account: AccountView;
  readonly program: ProgramId;
  readonly grant: GrantId | null;
  readonly onClose: () => void;
}) {
  // TODO: prepare = useAction('claim.prepare') on mount; confirm = useAction('claim.confirm');
  //       after confirm, follow the live record: props.account.claims.find(c => c.id === claim.id)
  void useAction;
  throw new Error('not implemented');
}
