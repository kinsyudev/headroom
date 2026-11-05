/** Which way a figure is better when it moves: up, down, or neither, as with volume. Every KPI names one. */
export type Better = 'up' | 'down' | null;

export interface DeltaRead {
  readonly direction: 'up' | 'down' | 'flat';
  readonly tone: 'neutral' | 'good' | 'bad';
}

const FLAT_BELOW = 0.005;
/** A move is clearly good or bad from a point (1%) up. Under it the arrow still shows, and the colour stays out. */
const CLEAR_FROM = 0.01;

/** The one rule: colour says good or bad, and only for a figure with a better direction that has moved clearly. Volume is never coloured. */
export function readDelta(change: number, better: Better, flatBelow = FLAT_BELOW): DeltaRead {
  const size = Math.abs(change);
  const direction = size < flatBelow ? 'flat' : change > 0 ? 'up' : 'down';
  const tone = better === null || direction === 'flat' || size < CLEAR_FROM ? 'neutral' : direction === better ? 'good' : 'bad';
  return { direction, tone };
}
