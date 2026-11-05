import type { CSSProperties } from 'react';
import type { AccountId, GrantId, ProgramId } from '../../shared/domain';
import type { AccountView, LimitColumn, RoutingView, ServingWhy } from '../../shared/view';
import { leftLabel, PACE_TICK_HELP, reasonTitle } from '../format';
import { ActionButton } from './ActionButton';
import { ActivityCell } from './ActivitySparkline';
import { ModeLine } from './Freshness';
import { LimitCell, SpendCell } from './LimitRow';
import { PriorityStepper } from './PriorityStepper';
import { ResetOffers, resetsAnchor } from './ResetOffers';
import { Trouble } from './Trouble';
import { UpkeepMenu } from './UpkeepMenu';

const EXTRA_USAGE_HELP = 'Extra usage: pay-as-you-go requests past the plan limits. Off, including a zero budget, requests stop at the plan limits.';
const REQUESTS_HELP = 'Requests CPA routed to the account, one bar per 10 minutes. The count beside them covers the same bars.';
const NEW_SESSIONS_HELP = 'New sessions go here: first in the serve order under fill-first.';
const ACTIVE_HELP: Readonly<Record<ServingWhy, string>> = {
  fill_first_target: 'Answered a request in the last 2 min, and first in the serve order.',
  affinity: 'Answered a request in the last 2 min, finishing sessions that started here. New sessions go to the account first in the serve order.',
  round_robin: 'Answered a request in the last 2 min. Round-robin takes turns, so it takes new sessions in its turn.',
};

/** What Serve first does to this account's priority, or why it has nothing left to do. */
function serveFirstTitle(r: RoutingView, can: boolean): string {
  if (!can) return 'Already the highest priority, above every other account';
  const disabled = r.role.kind === 'disabled';
  const lift =
    r.firstTo === null ? 'Enable this account. Its priority already outranks every other account' : `Raise priority from ${r.priority} to ${r.firstTo}, ten above the highest other account${disabled ? ', and enable it' : ''}`;
  return `${lift}, ${r.ranksByPriority ? 'so new sessions go here first' : 'which fill-first reads. Round-robin ignores priority'}`;
}

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
  const a = props.account;
  const r = a.routing;
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
          {a.can.enable && (
            <ActionButton
              kind="account.setDisabled"
              input={{ account: a.id, disabled: false }}
              title="Put this account back in rotation"
              pendingLabel="Enabling…"
              done="enabled"
              variant="strong"
              testId="toggle-disabled"
            >
              Enable
            </ActionButton>
          )}
          <PriorityStepper account={a.id} routing={r} />
          <ActionButton
            kind="account.makePrimary"
            input={{ account: a.id }}
            disabled={!a.can.makePrimary}
            hidden={r.primary}
            title={serveFirstTitle(r, a.can.makePrimary)}
            pendingLabel="Saving…"
            done={(o) => (o.changed ? `priority ${o.priority}` : 'already first')}
            testId="make-primary"
          >
            Serve first
          </ActionButton>
        </div>
        <span className="foot-spacer" aria-hidden />
        <div className="foot-group upkeep">
          <ModeLine account={a} />
          <UpkeepMenu account={a} />
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
      return takesNew ? (
        <span className="badge good role" data-testid="role" title={`${NEW_SESSIONS_HELP} Answered a request in the last 2 min.`}>
          ● New sessions
        </span>
      ) : (
        <span className="badge neutral role" data-testid="role" title={ACTIVE_HELP[role.why]}>
          <span className="role-live" aria-hidden>
            ●
          </span>{' '}
          Active
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
