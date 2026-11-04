/**
 * Stacked bar chart in plain SVG. There's no chart library: ≤ 30 bars × ≤ 5 series doesn't need one.
 * Series colours are fixed per AccountId (a stable hash into a 6-colour palette), so an account keeps
 * its colour across ranges, metrics, and reloads.
 */
export interface Series {
  readonly key: string;
  readonly label: string;
  readonly values: readonly number[]; // aligned with `buckets`
}

export function BarChart(props: {
  readonly buckets: readonly number[]; // bucket start Instants
  readonly series: readonly Series[];
  readonly markers?: readonly number[]; // e.g. 429 counts per bucket, drawn as ticks
  readonly format: (n: number) => string;
  readonly bucket: 'hour' | 'day';
}) {
  throw new Error('not implemented');
}
