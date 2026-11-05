import { memo, useRef, useState } from 'react';
import { ChartTip } from './ChartTip';
import { roundedTop, tooltipLeft, useWidth } from './kit';

export interface Block {
  readonly start: number;
  readonly end: number;
  readonly value: number;
}

const H = 30;
const GAP = 3;
const TIP_W = 190;

/**
 * Fourteen blocks as a sparkline: the first `split` are the earlier period, drawn dim, and the rest are the latest, drawn bright.
 * The bars start at zero and share one scale, so the two periods can be compared by eye.
 */
export const Blocks = memo(function Blocks(props: {
  readonly blocks: readonly Block[];
  readonly split: number;
  readonly format: (n: number) => string;
  readonly describe: (b: Block) => string;
  readonly unit: string;
  readonly label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 160);
  const [hover, setHover] = useState<number | null>(null);
  const n = props.blocks.length;
  const max = Math.max(1, ...props.blocks.map((b) => b.value));
  const band = width / n;
  const bw = Math.max(2, band - GAP);
  const b = hover === null ? null : props.blocks[hover]!;
  return (
    <div className="blocks" ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={props.label}>
        <line x1={0} x2={width} y1={H - 0.5} y2={H - 0.5} className="axis" />
        {props.blocks.map((blk, i) => {
          const h = blk.value <= 0 ? 0 : Math.max(2.5, (blk.value / max) * (H - 3));
          const x = i * band + (band - bw) / 2;
          return (
            <g key={blk.start} opacity={hover === null || hover === i ? 1 : 0.5} onPointerEnter={() => setHover(i)}>
              <rect x={i * band} y={0} width={band} height={H} fill="transparent" />
              {h > 0 && <path d={roundedTop(x, H - 1 - h, bw, h)} fill={i < props.split ? 'var(--ice-2)' : 'var(--ice-5)'} />}
            </g>
          );
        })}
      </svg>
      {b && <ChartTip left={tooltipLeft(hover! * band, band, width, TIP_W)} top={H + 6} width={TIP_W} title={props.describe(b)} rows={[{ key: 'v', value: props.format(b.value), label: props.unit }]} />}
    </div>
  );
});
