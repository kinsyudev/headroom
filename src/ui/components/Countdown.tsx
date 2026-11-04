/**
 * Time-relative text. Both components read the shared 1 Hz clock (useNow), so they tick together and
 * there is no per-component interval.
 */
import { useNow } from '../deck';

/** "1h 54m" until `at`; "now" once passed. `title` shows the absolute local time. */
export function Countdown(props: { readonly at: number | null }) {
  void useNow;
  throw new Error('not implemented');
}

/** "3s", "4m", "2h" since `at`. */
export function Age(props: { readonly at: number | null }) {
  throw new Error('not implemented');
}
