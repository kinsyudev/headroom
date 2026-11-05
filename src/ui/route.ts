import { useEffect, useState } from 'react';

/** The page has two views. The Usage tab's test id is nav-analytics, which the screenshot harness clicks. */
export const VIEWS = [
  { key: 'monitor', label: 'Monitor', hash: '#monitor', testId: 'nav-monitor' },
  { key: 'usage', label: 'Usage', hash: '#usage', testId: 'nav-analytics' },
] as const;

export type ViewKey = (typeof VIEWS)[number]['key'];

const USAGE = '#usage';

/** #usage opens Usage, and #usage/<id> opens it on the element with that id. Any other hash, such as a jump link to a card, stays on Monitor. */
const viewOf = (hash: string): ViewKey => (hash === USAGE || hash.startsWith(`${USAGE}/`) ? 'usage' : 'monitor');
const targetOf = (hash: string): string | null => (hash.startsWith(`${USAGE}/`) ? decodeURIComponent(hash.slice(USAGE.length + 1)) : null);

/** A link that opens Usage on one element, such as a quota pace row. */
export const usageLink = (id: string) => `${USAGE}/${encodeURIComponent(id)}`;

export const paceAnchor = (account: string, limitKey: string) => `pace-${account}-${limitKey}`;

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function useView(): ViewKey {
  const view = viewOf(useHash());
  useEffect(() => {
    const hash = window.location.hash;
    if ((view === 'usage' && targetOf(hash) === null) || hash === '#monitor') window.scrollTo(0, 0);
  }, [view]);
  return view;
}

/** The element a #usage/<id> link opened on, scrolled to and focused once it is on the page. */
export function useJumpTarget(): string | null {
  const target = targetOf(useHash());
  useEffect(() => {
    const el = target === null ? null : document.getElementById(target);
    el?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
  }, [target]);
  return target;
}
