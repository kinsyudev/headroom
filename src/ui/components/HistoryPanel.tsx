/**
 * Usage history from keeper (read-only), pulled with useHistory(range), not part of the snapshot.
 *
 *  History  [24h] 7d 30d     metric: [requests] fresh input · cache read · output     keeper: last row <Age>
 *  <BarChart>   stacked per account, one bar per hour (24h) or local day (7d/30d); 429s as a red tick per bar
 *  Per model    table: account · model · requests · failed · fresh in · cache read · cache create · out · avg latency · avg TTFT
 *  Recent errors table: time · account · model · status · quota reason · recover at · message (truncated, expandable)
 *
 * The "fresh input" column header has a tooltip: "input_tokens - cache_read - cache_creation; keeper's
 * input_tokens already includes cache for Claude."
 */
import type { HistoryRange } from '../../shared/history';
import { useHistory } from '../api';
import { BarChart } from './BarChart';

export function HistoryPanel(props: { readonly emails: ReadonlyMap<string, string> }) {
  // TODO: const [range, setRange] = useState<HistoryRange>('24h'); const [metric, setMetric] = useState<Metric>('requests');
  //       const { history, error } = useHistory(range);
  void [useHistory, BarChart];
  throw new Error('not implemented');
}

export type Metric = 'requests' | 'freshInput' | 'cacheRead' | 'output';
