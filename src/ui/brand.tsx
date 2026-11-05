import { useId } from 'react';

/**
 * The mark is an arch with a dot under it, cut out of an ice tile: a doorway, the dot is you, and the space above it is the
 * headroom. The favicon in index.html is the same drawing.
 */
export function Mark(props: { readonly size?: number }) {
  const size = props.size ?? 32;
  const ice = useId();
  return (
    <svg className="mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden focusable="false">
      <defs>
        <linearGradient id={ice} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ice-5)" />
          <stop offset="1" stopColor="var(--ice-4)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${ice})`} />
      <path className="mark-arch" d="M8 27V16a8 8 0 0 1 16 0V27" />
      <circle className="mark-dot" cx="16" cy="21.5" r="3.6" />
    </svg>
  );
}

/** "head" holds and "room" is the space: "room" has no ascenders, so the ceiling drawn at their height leaves room above it. */
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
