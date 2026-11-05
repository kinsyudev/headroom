import type { ReactNode } from 'react';
import type { AccountView, FeedName, FreshnessView, StatusView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, duration, sourceError } from '../format';
import { Segments } from './Segments';

const LABEL: Readonly<Record<FeedName, string>> = {
  cpa: 'CPA',
  strategy: 'Routing',
  serving: 'History',
  headers: 'headers',
  limits: 'limits',
  spend: 'spend',
  cedar: 'grants',
  juniper: 'weekly reset',
  profile: 'profile',
};

const ROLE: Partial<Record<FeedName, string>> = {
  cpa: 'accounts, cooldowns and priorities from CPA',
  strategy: 'the routing strategy from CPA',
  serving: 'the request log behind Serving now and History',
};

const HELD: Partial<Record<FeedName, string>> = {
  juniper: 'read only while the account is at its limit',
  spend: 'skipped while the account is at its limit',
};

const ICON: Partial<Record<FreshnessView['state'], string>> = { failing: '✕', stale: '!', never: '○' };

const STATE_WORD: Partial<Record<FreshnessView['state'], string>> = { traffic: 'from live traffic' };

function feedDetail(f: FreshnessView, now: number): string {
  return [
    `${LABEL[f.feed]}: ${STATE_WORD[f.state] ?? f.state}`,
    f.state === 'held' ? (HELD[f.feed] ?? 'held') : null,
    f.ageMs !== null ? `data ${age(f.ageMs)} old` : 'no data yet',
    f.error && f.errorAgeMs !== null ? `${sourceError(f.error)} ${age(f.errorAgeMs)} ago` : null,
    f.nextAt !== null && f.nextAt > now ? `next read ${clockTime(f.nextAt, now)}` : null,
    ROLE[f.feed] ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function problemText(f: FreshnessView): string {
  if (f.state === 'failing') return f.error?.kind === 'cpa_unreachable' ? sourceError(f.error) : `${LABEL[f.feed]} read failing`;
  return f.ageMs === null ? `${LABEL[f.feed]} not read yet` : `${LABEL[f.feed]} not updated for ${age(f.ageMs)}`;
}

export function Status(props: { readonly status: StatusView }) {
  const now = useNow();
  const { sources, problems, newestAgeMs } = props.status;
  const shown = [...new Map(problems.map((f) => [problemText(f), f] as const))];
  return (
    <div className="status num" data-testid="status" title={sources.map((f) => feedDetail(f, now)).join('\n')}>
      {shown.length === 0 ? (
        <span className="nowrap">
          <span className="status-live">Live</span>
          {newestAgeMs !== null && ` · updated ${age(newestAgeMs)} ago`}
        </span>
      ) : (
        shown.map(([text, f]) => (
          <span key={f.feed} className={`chip state-${f.state}`} title={feedDetail(f, now)} data-feed={f.feed}>
            {ICON[f.state] && (
              <span className="chip-icon" aria-hidden>
                {ICON[f.state]}
              </span>
            )}
            {text}
          </span>
        ))
      )}
    </div>
  );
}

const PROBLEMS = ['failing', 'stale', 'aging'] as const;

export function ModeLine(props: { readonly account: AccountView }) {
  const now = useNow();
  const { atWall, read, freshness, routing } = props.account;
  const limitsFailing = freshness.some((f) => f.feed === 'limits' && f.state === 'failing');

  const clauses: ReactNode[] = [read.lastAt === null ? 'not read yet' : `read ${age(now - read.lastAt)} ago`];
  for (const state of PROBLEMS) {
    const feeds = freshness.filter((f) => f.state === state);
    if (feeds.length === 0) continue;
    clauses.push(
      <span className={`chip state-${state}`}>
        {ICON[state] && <span className="chip-icon" aria-hidden>{ICON[state]}</span>}
        {feeds.map((f) => LABEL[f.feed]).join(', ')} {state === 'failing' ? 'read failing' : state}
      </span>,
    );
  }
  if (read.reading) clauses.push('reading now');
  else if (read.paused) clauses.push('reads paused');
  else if (read.nextAt !== null) clauses.push(read.nextAt > now ? `${limitsFailing ? 'retry' : 'next read'} in ${duration(read.nextAt - now)}` : 'next read due');
  if (read.backoffUntil !== null) clauses.push(`rate-limited until ${clockTime(read.backoffUntil, now)}`);
  if (read.capUntil !== null) clauses.push(`read cap full, next read allowed ${clockTime(read.capUntil, now)}`);

  const cadence = atWall ? 'At limit: limits and claimable resets are read every 3 min' : 'Normal: usage is read every 5 min';
  return (
    <div className="mode num" data-testid="freshness" title={[cadence, ...freshness.map((f) => feedDetail(f, now))].join('\n')}>
      {atWall && routing.role.kind !== 'blocked' && <span className="badge warning">At limit</span>}
      <div className="mode-text">
        <Segments parts={clauses} />
      </div>
    </div>
  );
}
