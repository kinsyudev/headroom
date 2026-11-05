import type { CSSProperties } from 'react';

/** How a series is drawn, so its key says so: a filled column, a solid line, a dashed line, or a dim ghost column behind the rest. */
export type KeyMark = 'square' | 'line' | 'dash' | 'ghost';

export function Key(props: { readonly mark: KeyMark; readonly color: string }) {
  return <span className={`key ${props.mark}`} style={{ '--key': props.color } as CSSProperties} aria-hidden />;
}
