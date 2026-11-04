/**
 * One chip per feed: "limits 4m · rate-limited 1m ago · retry 14:02". Passive headers read
 * "headers 3s" in plain ink: their age is the last request, not a failure.
 */
import type { FeedName, FreshnessView } from '../../shared/view';
import { useNow } from '../deck';
import { age, clockTime, sourceError } from '../format';

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

const HELD: Partial<Record<FeedName, string>> = { juniper: 'read only at the wall', spend: 'skipped at the wall' };

const ICON: Partial<Record<FreshnessView['state'], string>> = { failing: '✕', stale: '!', never: '○' };

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
  const data = f.ageMs === null ? '—' : age(f.ageMs);
  const parts = f.state === 'held' ? [...(data === '—' ? [] : [data]), HELD[f.feed] ?? 'held'] : [data];
  if (f.error && f.errorAgeMs !== null) parts.push(`${sourceError(f.error)} ${age(f.errorAgeMs)} ago`);
  const retry = f.error?.kind === 'rate_limited' ? f.error.retryAt : f.state === 'failing' ? f.nextAt : null;
  if (retry !== null && retry > now) parts.push(`retry ${clockTime(retry, now)}`);
  const title = [
    `${LABEL[f.feed]}: ${f.state}`,
    f.ageMs !== null ? `data ${age(f.ageMs)} old` : 'no data yet',
    f.nextAt !== null && f.nextAt > now ? `next read ${clockTime(f.nextAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={`chip state-${f.state}`} title={title} data-feed={f.feed}>
      {ICON[f.state] && <span className="chip-icon" aria-hidden>{ICON[f.state]}</span>}
      <span className="chip-label">{LABEL[f.feed]}</span> {parts.join(' · ')}
    </li>
  );
}
