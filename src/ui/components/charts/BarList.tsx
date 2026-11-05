import type { ReactNode } from 'react';

export interface BarRow {
  readonly key: string;
  readonly label: string;
  /** 0 to 1: what the bar fills. */
  readonly fill: number;
  /** The figure at the end of the row. */
  readonly text: string;
  readonly color: string;
  /** What the hover card says, as one line per figure. */
  readonly tip: readonly { readonly value: string; readonly label: string }[];
  readonly swatch?: boolean;
}

/**
 * A ranked list of shares. One thin bar per row, drawn from the zero baseline and capped at the full width, with the figure at its end.
 * With onSelect a row is a toggle that narrows the rest of the page to it.
 */
export function BarList(props: { readonly label: string; readonly rows: readonly BarRow[]; readonly selected?: string | null; readonly onSelect?: (key: string) => void; readonly empty?: ReactNode }) {
  if (props.rows.length === 0) return <p className="muted">{props.empty ?? 'Nothing in this range.'}</p>;
  return (
    <ul className="bars" aria-label={props.label}>
      {props.rows.map((r) => {
        const body = (
          <>
            <span className="bar-label">
              {r.swatch && <span className="swatch small" style={{ background: r.color }} aria-hidden />}
              <span className="bar-name">{r.label}</span>
              <span className="bar-text num">{r.text}</span>
            </span>
            <span className="bar-track" aria-hidden>
              <span className="bar-fill" style={{ width: `${Math.max(r.fill > 0 ? 0.8 : 0, r.fill * 100)}%`, background: r.color }} />
            </span>
            <span className="pop" role="tooltip">
              <strong className="pop-title">{r.label}</strong>
              {r.tip.map((t) => (
                <span key={t.label} className="tooltip-row">
                  <strong className="num">{t.value}</strong>
                  <span className="muted">{t.label}</span>
                </span>
              ))}
            </span>
          </>
        );
        const active = props.selected === r.key;
        return (
          <li key={r.key} className={`bar-row ${active ? 'active' : ''}`}>
            {props.onSelect ? (
              <button type="button" className="bar-body" aria-pressed={active} onClick={() => props.onSelect!(r.key)}>
                {body}
              </button>
            ) : (
              <div className="bar-body" tabIndex={0}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
