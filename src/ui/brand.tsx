/**
 * The mark is an arch with a dot under it: a doorway, the dot is you, and the space above it is the headroom. The
 * favicon in index.html is the same drawing on a dark tile.
 */
export function Mark(props: { readonly size?: number }) {
  const size = props.size ?? 24;
  return (
    <svg className="mark" viewBox="0 0 24 24" width={size} height={size} aria-hidden focusable="false">
      <path className="mark-arch" d="M4.5 21V11.5a7.5 7.5 0 0 1 15 0V21" />
      <circle className="mark-dot" cx="12" cy="16.6" r="3.1" />
    </svg>
  );
}

/** "head" holds, "room" is the space: the same word in two weights and two tones. */
export function Wordmark(props: { readonly as?: 'h1' | 'span' }) {
  const Tag = props.as ?? 'h1';
  return (
    <Tag className="wordmark" aria-label="Headroom">
      <span className="head" aria-hidden>
        head
      </span>
      <span className="room" aria-hidden>
        room
      </span>
    </Tag>
  );
}
