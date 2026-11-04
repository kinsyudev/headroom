/** Time-relative text. Everything reads the shared 1 Hz clock, so it all ticks together. */
import { useNow } from '../deck';
import { age, clockTime, duration } from '../format';

export function Countdown(props: { readonly at: number | null }) {
  const now = useNow();
  if (props.at === null) return <span className="muted">—</span>;
  return (
    <time className="num" dateTime={new Date(props.at).toISOString()} title={new Date(props.at).toLocaleString()}>
      {duration(props.at - now)}
    </time>
  );
}

/** "15:20", "Thu 09:00". */
export function Clock(props: { readonly at: number }) {
  const now = useNow();
  return (
    <time className="num" dateTime={new Date(props.at).toISOString()} title={new Date(props.at).toLocaleString()}>
      {clockTime(props.at, now)}
    </time>
  );
}

/** "3s", "4m" since `at`. */
export function Age(props: { readonly at: number | null }) {
  const now = useNow();
  if (props.at === null) return <span className="muted">never</span>;
  return (
    <time className="num" dateTime={new Date(props.at).toISOString()} title={new Date(props.at).toLocaleString()}>
      {age(now - props.at)}
    </time>
  );
}
