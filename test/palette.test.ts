import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../src/ui/styles.css'), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
/** A token's hex, following `var(--other)` aliases. */
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6}|var\\(--([a-z0-9-]+)\\))`).exec(root);
  if (!m) throw new Error(`--${name} is not a hex or alias token in :root`);
  return m[2] ? token(m[2]) : m[1]!.toLowerCase();
};

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const oklab = (hex: string) => {
  const [r, g, b] = rgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s] as const;
};
const deltaE = (a: string, b: string) => {
  const [x, y] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

const SURFACES = ['page', 'surface', 'surface-2', 'raised'] as const;

describe('the palette keeps the page legible', () => {
  test.each(['ink', 'ink-2', 'muted', 'brand', 'link', 'brand-ink', 'critical-ink', 'warning', 'good'])('text token --%s clears 4.5:1 on every surface', (name) => {
    for (const surface of SURFACES) expect(contrast(token(name), token(surface))).toBeGreaterThanOrEqual(4.5);
  });

  test.each(['ice-3', 'ice-4', 'ice-5', 'ice-6', 'quiet', 'critical', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5'])('mark token --%s clears 3:1 on the card surface', (name) => {
    expect(contrast(token(name), token('surface'))).toBeGreaterThanOrEqual(3);
  });
});

describe('identity hues are told apart from each other and from the status colours', () => {
  const identity = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'].map(token);

  test('neighbouring identity hues are at least 15 apart under normal vision, the dataviz floor', () => {
    for (let i = 1; i < identity.length; i++) expect(deltaE(identity[i - 1]!, identity[i]!)).toBeGreaterThanOrEqual(15);
  });

  test('no identity hue sits within 15 of a status colour, the same floor the dataviz method sets between series', () => {
    for (const hue of identity) for (const status of ['good', 'warning', 'critical', 'critical-ink'].map(token)) expect(deltaE(hue, status)).toBeGreaterThanOrEqual(15);
  });
});
