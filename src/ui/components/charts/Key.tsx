import type { CSSProperties } from 'react';

/** How a series is drawn, so its key says so: a filled column, a solid line, or a dashed line. A short level mark across a column uses the line. */
export type KeyMark = 'square' | 'line' | 'dash';

export function Key(props: { readonly mark: KeyMark; readonly color: string }) {
  return <span className={`key ${props.mark}`} style={{ '--key': props.color } as CSSProperties} aria-hidden />;
}
