/**
 * How a figure moved against the period before. The arrow and the words carry it; the colour only says whether the move is good,
 * and only for figures where one direction is better. Volume is neither, so it stays neutral.
 */
export function Delta(props: { readonly change: number | null; readonly text: string; readonly better?: 'up' | 'down'; readonly vs: string; readonly flatBelow?: number }) {
  if (props.change === null) return <span className="delta muted">No earlier week to compare</span>;
  const dir = Math.abs(props.change) < (props.flatBelow ?? 0.005) ? 'flat' : props.change > 0 ? 'up' : 'down';
  const tone = props.better === undefined || dir === 'flat' ? 'neutral' : dir === props.better ? 'good' : 'bad';
  return (
    <span className={`delta ${tone}`}>
      <span className="delta-move">
        <span aria-hidden>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▬'}</span>
        {dir === 'flat' ? 'No change' : props.text}
      </span>
      <span className="delta-vs">{props.vs}</span>
    </span>
  );
}
