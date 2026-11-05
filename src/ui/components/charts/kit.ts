import { useEffect, useState, type RefObject } from 'react';

/** The pixel width of an element, kept current as it resizes. Charts draw to it, so they stay crisp at any column width. */
export function useWidth(ref: RefObject<HTMLElement | null>, initial = 800): number {
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Round axis ticks from 0 up to just past max, about `n` of them. */
export function niceTicks(max: number, n = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = 0; t < max + step * 0.999; t += step) ticks.push(Math.round(t / step) * step);
  return ticks;
}

/** A column's rounded top: an arch when the column is thin, a 4px corner when it is wide. */
export function roundedTop(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const bottom = top + h;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
}

export const TOOLTIP_W = 250;

/** Which side of the pointer the tooltip sits on, so it never runs off the plot. */
export function tooltipLeft(columnX: number, band: number, plotRight: number, width = TOOLTIP_W): number {
  return columnX + band / 2 < plotRight / 2 ? columnX + band + 8 : Math.max(0, columnX - width - 8);
}
