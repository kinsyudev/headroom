/**
 * One account. It renders from AccountView only. Every "can I?" comes from `account.can`, every state
 * from derive.ts. This file holds layout and wiring, nothing else.
 *
 *  ┌ email · <PlanBadge> ─────────────────────────────── <RoutingBadge> ─ ⋯ menu ┐
 *  │ priority [ 50 ▾ ]  [Make primary]                                           │
 *  │ cooldowns: credential_quota → 15:20 <Countdown>  [Clear cooldown]           │
 *  │ statusMessage (if any), muted                                               │
 *  │ <LimitRow> × limits                                                         │
 *  │ <SpendRow>                                                                  │
 *  │ <ResetOffers>                                                               │
 *  │ <ActivitySparkline>                                                         │
 *  └ <FreshnessFooter>  [↻ refresh]                                              ┘
 *
 * The ⋯ menu holds Enable/Disable and Refresh token. Each item is a useAction('…') button:
 *   const toggle = useAction('account.setDisabled');
 *   <MenuItem disabled={toggle.pending || !account.can.disable} onClick={() => toggle.run({ account: account.id, disabled: true })}>
 */
import type { AccountView } from '../../shared/view';
import { useAction } from '../api';
import { ActivitySparkline } from './ActivitySparkline';
import { FreshnessFooter } from './FreshnessFooter';
import { LimitRow, SpendRow } from './LimitRow';
import { ResetOffers } from './ResetOffers';

export function AccountCard(props: { readonly account: AccountView }) {
  // TODO: layout above. makePrimary = useAction('account.makePrimary'); priority = useAction('account.setPriority');
  //       clear = useAction('account.clearCooldown'); refresh = useAction('quota.refresh'); errors render inline under the control.
  void [useAction, ActivitySparkline, FreshnessFooter, LimitRow, SpendRow, ResetOffers];
  throw new Error('not implemented');
}

/** "SERVING" (green), "standby", "BLOCKED 1h 54m" (amber, live countdown), "disabled" (grey). "target" marker when isTarget. */
export function RoutingBadge(props: { readonly routing: AccountView['routing'] }) {
  throw new Error('not implemented');
}
