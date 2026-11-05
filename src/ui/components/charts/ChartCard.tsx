import { useState, type ReactNode } from 'react';
import { TableScroll } from '../TableScroll';
import { Key, type KeyMark } from './Key';
import { Switch } from './Switch';

/** The numbers behind a chart, as a table. The first column names the row and the rest are figures. */
export interface TableData {
  readonly head: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
}

export function DataTable(props: { readonly data: TableData; readonly label: string }) {
  return (
    <TableScroll label={props.label}>
      <table className="data">
        <thead>
          <tr>
            {props.data.head.map((h, i) => (
              <th key={h} className={i > 0 ? 'num' : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.data.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} className={i > 0 ? 'num' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

type Face = 'chart' | 'table';

const FACES: readonly { readonly key: Face; readonly label: string }[] = [
  { key: 'chart', label: 'Chart' },
  { key: 'table', label: 'Table' },
];

/** The frame every usage chart sits in: a title, what it measures, its controls and legend, and the same data as a table. */
export function ChartCard(props: {
  readonly title: string;
  readonly sub?: ReactNode;
  readonly actions?: ReactNode;
  readonly legend?: ReactNode;
  readonly table?: TableData;
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const [face, setFace] = useState<Face>('chart');
  return (
    <section className={`card ${props.className ?? ''}`} aria-label={props.title} data-testid={props.testId}>
      <div className="card-head">
        <div className="card-title">
          <h2>{props.title}</h2>
          {props.sub && <p>{props.sub}</p>}
        </div>
        {(props.actions || props.table) && (
          <div className="card-actions">
            {props.actions}
            {props.table && <Switch label={`${props.title} view`} options={FACES} value={face} onChange={setFace} />}
          </div>
        )}
      </div>
      {props.legend}
      {face === 'table' && props.table ? <DataTable data={props.table} label={`${props.title} as a table`} /> : props.children}
    </section>
  );
}

export interface LegendItem {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** A glyph that says what the colour says, for series that carry a status. */
  readonly icon?: string;
  readonly mark?: KeyMark;
}

export function Legend(props: { readonly items: readonly LegendItem[] }) {
  return (
    <ul className="legend-items" aria-label="Legend">
      {props.items.map((s) => (
        <li key={s.key} className="legend-item">
          <Key mark={s.mark ?? 'square'} color={s.color} />
          {s.icon && (
            <span className="legend-icon" aria-hidden>
              {s.icon}
            </span>
          )}
          {s.label}
        </li>
      ))}
    </ul>
  );
}
