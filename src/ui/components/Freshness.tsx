import { Fragment, type ReactNode } from 'react';
import type { AccountView, FeedName, FreshnessView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, duration, sourceError } from '../format';

const LABEL: Readonly<Record<FeedName, string>> = {
  cpa: 'CPA',
  strategy: 'routing',
  serving: 'keeper',
  headers: 'headers',
  limits: 'limits',
  spend: 'spend',
  cedar: 'grants',
  juniper: 'weekly reset',
  profile: 'profile',
};

const CARD_LABEL: Readonly<Record<FeedName, string>> = { ...LABEL, cpa: 'CPA data' };

const HELD: Partial<Record<FeedName, string>> = { juniper: 'read only at the wall', spend: 'skipped at the wall' };

const ICON: Partial<Record<FreshnessView['state'], string>> = { failing: '✕', stale: '!', never: '○' };

const STATE_WORD: Partial<Record<FreshnessView['state'], string>> = { traffic: 'from live traffic' };

function feedDetail(f: FreshnessView, now: number): string {
  return [
    `${LABEL[f.feed]}: ${STATE_WORD[f.state] ?? f.state}`,
    f.state === 'held' ? (HELD[f.feed] ?? 'held') : null,
    f.ageMs !== null ? `data ${age(f.ageMs)} old` : 'no data yet',
    f.error && f.errorAgeMs !== null ? `${sourceError(f.error)} ${age(f.errorAgeMs)} ago` : null,
    f.nextAt !== null && f.nextAt > now ? `next read ${clockTime(f.nextAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function FreshnessChips(props: { readonly feeds: readonly FreshnessView[]; readonly testId?: string }) {
  return (
    <ul className="chips" data-testid={props.testId}>
      {props.feeds.map((f) => (
        <Chip key={f.feed} f={f} />
      ))}
    </ul>
  );
}

function Chip(props: { readonly f: FreshnessView }) {
  const now = useNow();
  const f = props.f;
  const parts = [f.ageMs === null ? '—' : age(f.ageMs)];
  if (f.error && f.errorAgeMs !== null) parts.push(`${sourceError(f.error)} ${age(f.errorAgeMs)} ago`);
  const retry = f.error?.kind === 'rate_limited' || f.error?.kind === 'read_cap' ? f.error.retryAt : f.state === 'failing' ? f.nextAt : null;
  if (retry !== null && retry > now) parts.push(`retry ${clockTime(retry, now)}`);
  return (
    <li className={`chip state-${f.state}`} title={feedDetail(f, now)} data-feed={f.feed}>
      {ICON[f.state] && <span className="chip-icon" aria-hidden>{ICON[f.state]}</span>}
      <span className="chip-label">{LABEL[f.feed]}</span> {parts.join(' · ')}
    </li>
  );
}

const PROBLEMS = ['failing', 'stale', 'aging'] as const;

const heldText = (f: FreshnessView) => `${LABEL[f.feed]} ${HELD[f.feed] ?? 'held'}`;

export function ModeLine(props: { readonly account: AccountView }) {
  const now = useNow();
  const { atWall, read, freshness } = props.account;
  const limitsFailing = freshness.some((f) => f.feed === 'limits' && f.state === 'failing');
  const held = freshness.filter((f) => f.state === 'held');

  const clauses: ReactNode[] = [read.lastAt === null ? 'not read yet' : `read ${age(now - read.lastAt)} ago`];
  for (const state of PROBLEMS) {
    const feeds = freshness.filter((f) => f.state === state);
    if (feeds.length === 0) continue;
    clauses.push(
      <span className={`chip state-${state}`}>
        {ICON[state] && <span className="chip-icon" aria-hidden>{ICON[state]}</span>}
        {feeds.map((f) => CARD_LABEL[f.feed]).join(', ')} {state === 'failing' ? 'read failing' : state}
      </span>,
    );
  }
  if (read.reading) clauses.push('reading now');
  else if (read.nextAt !== null) clauses.push(read.nextAt > now ? `${limitsFailing ? 'retry' : 'next read'} in ${duration(read.nextAt - now)}` : 'next read due');
  if (read.backoffUntil !== null) clauses.push(`rate-limited until ${clockTime(read.backoffUntil, now)}`);
  if (read.capUntil !== null) clauses.push(`read cap full, next read allowed ${clockTime(read.capUntil, now)}`);

  const cadence = atWall ? 'At the wall: reset programs are read every 3 min' : 'Normal: usage is read every 5 min';
  return (
    <div className="mode num" data-testid="freshness" title={[cadence, ...freshness.map((f) => feedDetail(f, now))].join('\n')}>
      {atWall ? <span className="badge warning">At the wall</span> : <span className="badge neutral">Normal</span>}{' '}
      <div className="mode-text muted">
        <div>
          {clauses.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && '\u00A0· '}
              <span className="nowrap">{c}</span>
            </Fragment>
          ))}
        </div>{' '}
        {held.length > 0 && <div>{held.map(heldText).join(' · ')}</div>}
      </div>
    </div>
  );
}
