import { Fragment, type ReactNode } from 'react';

export function Segments(props: { readonly parts: readonly ReactNode[] }) {
  return (
    <span className="segs">
      {props.parts.filter(Boolean).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="seg">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}
