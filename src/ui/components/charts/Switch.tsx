import type { ReactNode } from 'react';

/** A row of mutually exclusive choices. The selected one is pressed; the rest are quiet. */
export function Switch<T extends string>(props: {
  readonly label: string;
  readonly options: readonly { readonly key: T; readonly label: ReactNode; readonly title?: string }[];
  readonly value: T;
  readonly onChange: (key: T) => void;
  readonly className?: string;
  readonly testId?: (key: T) => string;
}) {
  return (
    <div className={`segmented ${props.className ?? ''}`} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`btn small ${o.key === props.value ? 'selected' : 'quiet'}`}
          aria-pressed={o.key === props.value}
          title={o.title}
          data-testid={props.testId?.(o.key)}
          onClick={() => props.onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
