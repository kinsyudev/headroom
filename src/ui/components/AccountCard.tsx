import type { GrantId, ProgramId } from '../../shared/domain';
import type { AccountView } from '../../shared/view';
import { reasonText, reasonTitle, SERVING_WHY } from '../format';
import { ActionButton } from './ActionButton';
import { ActivitySparkline } from './ActivitySparkline';
import { Clock, Countdown } from './Countdown';
import { ModeLine } from './Freshness';
import { LimitRow, SpendRow } from './LimitRow';
import { ResetOffers } from './ResetOffers';

const REFRESH_HELD: Readonly<Record<NonNullable<AccountView['read']['refreshHeld']>['why'], { readonly short: string; readonly long: string }>> = {
  reading: { short: 'already reading', long: 'A read is already running' },
  rate_limited: { short: 'rate-limited', long: 'Rate-limited; waiting for the backoff' },
  capped: { short: 'read cap full', long: 'At most 8 reads per account in 15 minutes; waiting for the oldest to age out' },
  debounced: { short: 'once per minute', long: 'Once per minute per account' },
};

export function AccountCard(props: { readonly account: AccountView; readonly color: string; readonly onClaim: (program: ProgramId, grant: GrantId | null) => void }) {
  const a = props.account;
  const r = a.routing;
  const held = a.read.refreshHeld;
  return (
    <article className={`card role-${r.role.kind}`} data-testid={`card-${a.email}`} data-account={a.id}>
      <header className="card-head">
        <span className="swatch" style={{ background: props.color }} aria-hidden />
        <div className="who">
          <h3 className="email">{a.email}</h3>
          <div className="sub">
            {a.plan?.label ?? 'plan unknown'} · priority <span className="num" data-testid="priority">{r.priority}</span>
          </div>
        </div>
        <RoutingBadge routing={r} />
      </header>

      <ModeLine account={a} />

      {(a.cooldowns.length > 0 || a.statusMessage) && (
        <div className="problems">
          {groupCooldowns(a.cooldowns).map((g) => (
            <div key={g.key} className="cooldown">
              <span className="badge critical">{g.models.length === 0 ? 'Account cooldown' : g.models.length === 1 ? 'Model cooldown' : `${g.models.length} model cooldowns`}</span> <span title={g.reasons.join(', ')}>{[...new Set(g.reasons.map(reasonText))].join(', ')}</span>
              {g.models.length > 0 && <span className="muted"> · {g.models.join(', ')}</span>} · until <Clock at={g.retryAt} />{' '}
              <span className="muted">
                (<Countdown at={g.retryAt} />)
              </span>
            </div>
          ))}
          {a.statusMessage && <p className="status-message">“{a.statusMessage}”</p>}
        </div>
      )}

      <section className="limits" aria-label="Usage windows">
        {a.limits.length === 0 && <p className="muted">No quota data yet. The first read is on its way.</p>}
        {a.limits.map((l) => (
          <LimitRow key={l.key} limit={l} />
        ))}
        <SpendRow spend={a.spend} atWall={a.atWall} />
      </section>

      <ResetOffers account={a} onClaim={props.onClaim} />

      <ActivitySparkline buckets={a.activity} color={props.color} />

      <footer className="card-foot">
        <div className="actions">
          <ActionButton
            kind="account.makePrimary"
            input={{ account: a.id }}
            disabled={!a.can.makePrimary}
            title={a.can.makePrimary ? 'Set priority above every other account' : 'Already outranks every other account'}
            pendingLabel="Making primary…"
            done={(o) => (o.changed ? `priority ${o.priority}` : 'already primary')}
            variant="primary"
            testId="make-primary"
          >
            Make primary
          </ActionButton>
          <span className="stepper" aria-label="Priority">
            <ActionButton kind="account.setPriority" input={{ account: a.id, priority: Math.max(0, r.priority - 10) }} disabled={r.priority === 0} title="Priority −10" done="saved" testId="priority-down">
              −10
            </ActionButton>
            <ActionButton kind="account.setPriority" input={{ account: a.id, priority: Math.min(1000, r.priority + 10) }} title="Priority +10" done="saved" testId="priority-up">
              +10
            </ActionButton>
          </span>
          <ActionButton
            kind="account.setDisabled"
            input={{ account: a.id, disabled: a.can.disable }}
            pendingLabel={a.can.disable ? 'Disabling…' : 'Enabling…'}
            done={a.can.disable ? 'disabled' : 'enabled'}
            variant={a.can.disable ? 'quiet' : 'primary'}
            testId="toggle-disabled"
          >
            {a.can.disable ? 'Disable' : 'Enable'}
          </ActionButton>
          <ActionButton
            kind="account.clearCooldown"
            input={{ account: a.id }}
            disabled={!a.can.clearCooldown}
            title={a.can.clearCooldown ? "Clear CPA's local cooldown. Does not contact Anthropic." : 'No cooldown to clear'}
            pendingLabel="Clearing…"
            done="cooldown cleared"
            testId="clear-cooldown"
          >
            Clear cooldown
          </ActionButton>
          <ActionButton kind="account.refreshToken" input={{ account: a.id }} pendingLabel="Refreshing…" done={(o) => (o.ok ? 'token refreshed' : 'CPA said not ok')} testId="refresh-token">
            Refresh token
          </ActionButton>
          <ActionButton
            kind="quota.refresh"
            input={{ account: a.id }}
            disabled={held !== null}
            title={held === null ? 'Read Anthropic usage now' : REFRESH_HELD[held.why].long}
            done={(o) => (o.scheduled[0]?.held ? `not queued: ${REFRESH_HELD[o.scheduled[0].held].short}` : 'read queued')}
            testId="refresh-quota"
          >
            ↻ Read now{(held?.why === 'debounced' || held?.why === 'capped') && held.until !== null ? <span className="muted"> <Countdown at={held.until} /></span> : null}
          </ActionButton>
        </div>
      </footer>
    </article>
  );
}

function groupCooldowns(cooldowns: AccountView['cooldowns']) {
  const groups = new Map<string, { key: string; retryAt: number; models: string[]; reasons: string[] }>();
  for (const c of cooldowns) {
    const key = c.scope === 'credential' ? 'account' : `models:${c.retryAt}`;
    const g = groups.get(key) ?? { key, retryAt: c.retryAt, models: [], reasons: [] };
    if (c.scope === 'model') g.models.push(c.model.replace(/^claude-/, ''));
    if (!g.reasons.includes(c.reason)) g.reasons.push(c.reason);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function RoutingBadge(props: { readonly routing: AccountView['routing'] }) {
  const role = props.routing.role;
  switch (role.kind) {
    case 'serving':
      return (
        <span className="badge good role" data-testid="role" title={SERVING_WHY[role.why].long}>
          ● Serving <span className="badge-sub">{SERVING_WHY[role.why].short}</span>
        </span>
      );
    case 'standby':
      return (
        <span className="badge neutral role" data-testid="role">
          ○ Standby
        </span>
      );
    case 'blocked':
      return (
        <span className="badge critical role" data-testid="role" title={reasonTitle(role.reason)}>
          ■ Blocked {role.until !== null && <Countdown at={role.until} />}
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
