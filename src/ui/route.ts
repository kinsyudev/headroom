import { useEffect, useState } from 'react';

/** The page has two views. The Usage tab's test id is nav-analytics, which the screenshot harness clicks. */
export const VIEWS = [
  { key: 'monitor', label: 'Monitor', hash: '#monitor', testId: 'nav-monitor' },
  { key: 'usage', label: 'Usage', hash: '#usage', testId: 'nav-analytics' },
] as const;

export type ViewKey = (typeof VIEWS)[number]['key'];

/** Only #usage opens Usage. Any other hash, such as a jump link to a card, stays on Monitor. */
const read = (): ViewKey => (window.location.hash === '#usage' ? 'usage' : 'monitor');

export function useView(): ViewKey {
  const [view, setView] = useState<ViewKey>(read);
  useEffect(() => {
    const onChange = () => setView(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  useEffect(() => {
    if (view === 'usage' || window.location.hash === '#monitor') window.scrollTo(0, 0);
  }, [view]);
  return view;
}
