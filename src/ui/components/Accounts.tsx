import type { CSSProperties } from 'react';
import type { AccountId, GrantId, ProgramId } from '../../shared/domain';
import type { AccountView, LimitColumn } from '../../shared/view';
import { useNow } from '../deck';
import { leftLabel, PACE_TICK_HELP, reasonTitle, SERVING_WHY } from '../format';
import { ActionButton } from './ActionButton';
import { ActivityCell } from './ActivitySparkline';
import { Countdown } from './Countdown';
import { ModeLine, nextCheck } from './Freshness';
import { LimitCell, SpendCell } from './LimitRow';
import { PriorityStepper } from './PriorityStepper';
import { ResetOffers, resetsAnchor } from './ResetOffers';
import { Trouble } from './Trouble';

const REFRESH_HELD: Readonly<Record<NonNullable<AccountView['read']['refreshHeld']>['why'], { readonly short: string; readonly long: string }>> = {
  reading: { short: 'already checking', long: 'A check is already running' },
  rate_limited: { short: 'rate-limited', long: 'Rate-limited; waiting for the backoff' },
  capped: { short: 'check cap full', long: 'At most 8 checks per account in 15 minutes; waiting for the oldest to age out' },
  debounced: { short: 'once per minute', long: 'Once per minute per account' },
};

const EXTRA_USAGE_HELP = 'Extra usage: pay-as-you-go requests past the plan limits. Off, including a zero budget, requests stop at the plan limits.';
const REQUESTS_HELP = 'Requests CPA routed to the account, per 10 minutes';
const PRIMARY_HELP = 'First in the serve order, so new sessions go here; raise another account above it to change';
const NEW_SESSIONS_HELP = 'New sessions go here: first in line under fill-first.';

export function Accounts(props: {
  readonly accounts: readonly AccountView[];
  readonly columns: readonly LimitColumn[];
  readonly colors: ReadonlyMap<AccountId, string>;
  readonly onClaim: (account: AccountId, program: ProgramId, grant: GrantId | null) => void;
}) {
  const style = { '--limit-cols': Math.max(1, props.columns.length) } as CSSProperties;
  return (
    <section className="panel accounts" aria-label="Accounts" style={style}>
      <div className="ledger-head" aria-hidden>
        <span>Account</span>
        {props.columns.length === 0 ? (
          <span>Room left</span>
        ) : (
          props.columns.map((c) => (
            <span key={c.key} title={[c.gloss && `${c.label}: ${c.gloss}`, PACE_TICK_HELP].filter(Boolean).join('\n')}>
              {leftLabel(c.label)}
            </span>
          ))
        )}
        <span title={EXTRA_USAGE_HELP}>Extra usage</span>
        <span title={REQUESTS_HELP}>Requests</span>
      </div>
      {props.accounts.length === 0 && <p className="acct-none muted">No Claude accounts in CPA yet.</p>}
      {props.accounts.map((a) => (
        <AccountRow key={a.id} account={a} columns={props.columns} color={props.colors.get(a.id)!} onClaim={(program, grant) => props.onClaim(a.id, program, grant)} />
      ))}
    </section>
  );
}

function AccountRow(props: {
  readonly account: AccountView;
  readonly columns: readonly LimitColumn[];
  readonly color: string;
  readonly onClaim: (program: ProgramId, grant: GrantId | null) => void;
}) {
  const now = useNow();
  const a = props.account;
  const r = a.routing;
  const held = a.read.refreshHeld;
  const offersOpen = a.quietOffers === null;
  return (
    <article className={`acct role-${r.role.kind}`} data-testid={`card-${a.email}`} data-account={a.id}>
      <header className="acct-id">
        <span className="swatch" style={{ background: props.color }} aria-hidden />
        <div className="who">
          <h3 className="email" title={a.email}>
            {a.email}
          </h3>
          <div className="who-sub">
            <RoutingBadge routing={r} />
            <span className="plan">{a.plan?.label ?? 'plan unknown'}</span>
          </div>
        </div>
      </header>

      {a.limits.length === 0 ? (
        <p className="cell acct-empty muted">No quota data yet. The first read is on its way.</p>
      ) : props.columns.length === 0 ? null : (
        props.columns.map((c) => {
          const l = a.limits.find((x) => x.key === c.key);
          return l ? <LimitCell key={c.key} account={a.id} limit={l} /> : <EmptyCell key={c.key} label={c.label} />;
        })
      )}
      <SpendCell spend={a.spend} atWall={a.atWall} help={EXTRA_USAGE_HELP} />
      <ActivityCell buckets={a.activity} color={props.color} help={REQUESTS_HELP} />

      {(a.trouble !== null || offersOpen) && (
        <section className="acct-attention" aria-label={a.trouble === null ? 'Resets you can claim' : 'Trouble and fixes'} id={resetsAnchor(a.id)} tabIndex={-1}>
          <Trouble account={a} />
          {offersOpen && <ResetOffers account={a} onClaim={props.onClaim} />}
        </section>
      )}

      <footer className="acct-foot">
        <div className="foot-group routing">
          <ActionButton
            kind="account.makePrimary"
            input={{ account: a.id }}
            disabled={!a.can.makePrimary}
            title={
              r.primary
                ? PRIMARY_HELP
                : a.can.makePrimary
                  ? 'Raise priority above every other account, so new sessions go here first'
                  : 'Already first in priority, outranking every other account'
            }
            pendingLabel="Saving…"
            done={(o) => (o.changed ? `priority ${o.priority}` : 'already first')}
            variant={r.primary ? 'state' : 'quiet'}
            testId="make-primary"
          >
            {r.primary ? '★ Serves first' : 'Serve first'}
          </ActionButton>
          <PriorityStepper account={a.id} routing={r} />
        </div>
        <span className="foot-spacer" aria-hidden />
        <div className="foot-group check">
          <ModeLine account={a} />
          <ActionButton
            kind="quota.refresh"
            input={{ account: a.id }}
            disabled={held !== null}
            title={[held === null ? 'Check Anthropic usage now' : REFRESH_HELD[held.why].long, nextCheck(a, now)].filter(Boolean).join('\n')}
            done={(o) => (o.scheduled[0]?.held ? `not queued: ${REFRESH_HELD[o.scheduled[0].held].short}` : 'check queued')}
            variant="ghost"
            testId="refresh-quota"
          >
            ↻ Check now{(held?.why === 'debounced' || held?.why === 'capped') && held.until !== null ? <span className="muted"> <Countdown at={held.until} /></span> : null}
          </ActionButton>
        </div>
        <div className="foot-group upkeep">
          <span className="foot-divider" aria-hidden />
          <ActionButton
            kind="account.refreshToken"
            input={{ account: a.id }}
            pendingLabel="Refreshing…"
            done={(o) => (o.ok ? 'token refreshed' : 'CPA said not ok')}
            variant="ghost"
            testId="refresh-token"
          >
            Refresh token
          </ActionButton>
          <ActionButton
            kind="account.setDisabled"
            input={{ account: a.id, disabled: a.can.disable }}
            title={a.can.disable ? 'Take this account out of rotation' : 'Put this account back in rotation'}
            pendingLabel={a.can.disable ? 'Disabling…' : 'Enabling…'}
            done={a.can.disable ? 'disabled' : 'enabled'}
            variant={a.can.disable ? 'ghost-danger' : 'strong'}
            testId="toggle-disabled"
          >
            {a.can.disable ? 'Disable' : 'Enable'}
          </ActionButton>
        </div>
      </footer>
    </article>
  );
}

function EmptyCell(props: { readonly label: string }) {
  return (
    <div className="cell" title={`No ${props.label.toLowerCase()} window on this account`}>
      <span className="cell-label">{leftLabel(props.label)}</span>
      <span className="cell-value muted">—</span>
    </div>
  );
}

export function RoutingBadge(props: { readonly routing: AccountView['routing'] }) {
  const { role, isTarget, ranksByPriority } = props.routing;
  const takesNew = isTarget && ranksByPriority;
  switch (role.kind) {
    case 'serving':
      return (
        <span className="badge good role" data-testid="role" title={takesNew ? `${NEW_SESSIONS_HELP} Answered a request in the last 2 min.` : `Answered a request in the last 2 min: ${SERVING_WHY[role.why]}`}>
          ● {takesNew ? 'New sessions' : 'Serving'}
        </span>
      );
    case 'standby':
      return (
        <span className="badge neutral role" data-testid="role" title={takesNew ? `${NEW_SESSIONS_HELP} No request in the last 2 min.` : 'In line, with no request in the last 2 min'}>
          ○ {takesNew ? 'New sessions' : 'Standby'}
        </span>
      );
    case 'blocked':
      return (
        <span className="badge critical role" data-testid="role" title={reasonTitle(role.reason)}>
          ■ Blocked
        </span>
      );
    case 'disabled':
      return (
        <span className="badge muted role" data-testid="role">
          – Disabled
        </span>
      );
  }
}
