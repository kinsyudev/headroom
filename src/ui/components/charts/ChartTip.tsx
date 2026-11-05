import type { CSSProperties, ReactNode } from 'react';

export interface TipRow {
  readonly key: string;
  /** The series' colour, drawn as a short line key beside the value. */
  readonly color?: string;
  readonly value: string;
  readonly label: string;
}

/** Values lead and names follow: at a tooltip the reader already has the series and wants the number. */
export function ChartTip(props: {
  readonly left: number;
  readonly top?: number;
  readonly width?: number;
  readonly title: string;
  readonly rows: readonly TipRow[];
  readonly total?: { readonly value: string; readonly label: string } | undefined;
  readonly children?: ReactNode;
}) {
  const style: CSSProperties = { left: props.left, ...(props.top === undefined ? {} : { top: props.top }), ...(props.width === undefined ? {} : { width: props.width }) };
  return (
    <div className="tooltip" style={style}>
      <div className="tooltip-title">{props.title}</div>
      {props.rows.map((r) => (
        <div key={r.key} className="tooltip-row">
          {r.color && <span className="line-key" style={{ background: r.color }} />}
          <strong className="num">{r.value}</strong>
          <span className="muted">{r.label}</span>
        </div>
      ))}
      {props.total && (
        <div className="tooltip-row total">
          <strong className="num">{props.total.value}</strong>
          <span className="muted">{props.total.label}</span>
        </div>
      )}
      {props.children}
    </div>
  );
}
