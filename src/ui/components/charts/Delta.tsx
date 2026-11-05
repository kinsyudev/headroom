import { readDelta, type Better } from './deltaRule';

/**
 * How a figure moved against the span before it. The arrow and the words carry it; the colour only says whether the move is good,
 * by the one rule in deltaRule. span names what it moved against, such as "7 days".
 */
export function Delta(props: { readonly change: number | null; readonly text: string; readonly better: Better; readonly span: string; readonly flatBelow?: number }) {
  if (props.change === null) return <span className="delta muted">No earlier {props.span} on record</span>;
  const { direction, tone } = readDelta(props.change, props.better, props.flatBelow);
  return (
    <span className={`delta ${tone}`}>
      <span className="delta-move">
        <span aria-hidden>{direction === 'up' ? '▲' : direction === 'down' ? '▼' : '▬'}</span>
        {direction === 'flat' ? 'No change' : props.text}
      </span>
      <span className="delta-vs">vs the {props.span} before</span>
    </span>
  );
}
