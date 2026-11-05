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
const chroma = (hex: string) => Math.hypot(oklab(hex)[1], oklab(hex)[2]);
const hue = (hex: string) => (Math.atan2(oklab(hex)[2], oklab(hex)[1]) * 180) / Math.PI;
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return Math.min(d, 360 - d);
};

const SURFACES = ['page', 'surface', 'surface-lit', 'surface-2', 'raised'] as const;
const TEXT = ['ink', 'ink-2', 'muted', 'brand', 'link', 'brand-ink', 'critical-ink', 'warning', 'good'] as const;

describe('the palette keeps the page legible', () => {
  test.each(TEXT)('text token --%s clears 4.5:1 on every surface', (name) => {
    for (const surface of SURFACES) expect(contrast(token(name), token(surface))).toBeGreaterThanOrEqual(4.5);
  });

  test.each(['ice-3', 'ice-4', 'ice-5', 'ice-6', 'quiet', 'slate', 'critical', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5'])('mark token --%s clears 3:1 on the card surface', (name) => {
    expect(contrast(token(name), token('surface'))).toBeGreaterThanOrEqual(3);
  });
});

const panel = (m: RegExpMatchArray) => Number(m[2]) <= 25 && (SURFACES as readonly string[]).includes(m[3]!);
const tints = [
  ...new Set(
    [...css.matchAll(/background:\s*color-mix\(in srgb, var\(--([a-z0-9-]+)\) (\d+)%, var\(--([a-z0-9-]+)\)\)/g)].filter(panel).map((m) => m[0].slice(m[0].indexOf('color-mix'))),
  ),
];
const parts = (tint: string) => {
  const [, a, p, b] = /var\(--([a-z0-9-]+)\) (\d+)%, var\(--([a-z0-9-]+)\)/.exec(tint)!;
  return { over: a!, share: Number(p), under: b! };
};
const mixed = (tint: string) => {
  const { over, share, under } = parts(tint);
  const [x, y] = [token(over), token(under)];
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(x.slice(i, i + 2), 16) * (share / 100) + parseInt(y.slice(i, i + 2), 16) * (1 - share / 100)).toString(16).padStart(2, '0')).join('')}`;
};

describe('every text token stays legible on every tinted panel the stylesheet draws', () => {
  test('the stylesheet has tinted panels to check', () => {
    expect(tints.length).toBeGreaterThan(5);
  });

  test.each(tints.flatMap((tint) => TEXT.filter((name) => name !== 'good').map((name) => [name, tint] as const)))('--%s clears 4.5:1 on %s', (name, tint) => {
    expect(contrast(token(name), mixed(tint))).toBeGreaterThanOrEqual(4.5);
  });

  // Green sets words only on the plain surfaces. On a tint it draws a dot or a fill, which needs the 3:1 of a mark.
  test.each(tints)('--good clears 3:1 as a mark on %s', (tint) => {
    expect(contrast(token('good'), mixed(tint))).toBeGreaterThanOrEqual(3);
  });
});

describe('text set under 13px clears 7:1 on every surface it sits on', () => {
  // Tiles and rows wash at 14% or less. Stronger fills are buttons, badges and status boxes, whose text is 13px or more.
  const washes = tints.filter((tint) => parts(tint).share <= 14);
  const brandWashes = washes.filter((tint) => ['accent', 'brand'].includes(parts(tint).over));

  test('the tiles have washes to check, the claimable ones among them', () => {
    expect(washes.length).toBeGreaterThan(5);
    expect(brandWashes.length).toBeGreaterThan(1);
  });

  // The uppercase labels and chart ticks are 12px in --muted, and the chart end labels 12px in --ink-2.
  test.each(['muted', 'ink-2'].flatMap((name) => [...SURFACES, ...washes].map((on) => [name, on] as const)))('--%s clears 7:1 on %s', (name, on) => {
    expect(contrast(token(name), on.startsWith('color-mix') ? mixed(on) : token(on))).toBeGreaterThanOrEqual(7);
  });

  // An uppercase label on a claimable tile turns --link.
  test.each(brandWashes)('--link clears 7:1 on %s', (tint) => {
    expect(contrast(token('link'), mixed(tint))).toBeGreaterThanOrEqual(7);
  });
});

describe('identity hues are told apart from each other and from the status colours', () => {
  const identity = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'].map(token);

  test('neighbouring identity hues are at least 15 apart under normal vision, the dataviz floor', () => {
    for (let i = 1; i < identity.length; i++) expect(deltaE(identity[i - 1]!, identity[i]!)).toBeGreaterThanOrEqual(15);
  });

  test('the first three, which sit side by side in the serve order and every legend, are 15 apart as every pair', () => {
    const [a, b, c] = identity as [string, string, string];
    for (const [x, y] of [[a, b], [b, c], [a, c]] as const) expect(deltaE(x, y)).toBeGreaterThanOrEqual(15);
  });

  test('no identity hue sits within 15 of a status colour, the same floor the dataviz method sets between series', () => {
    for (const hue of identity) for (const status of ['good', 'warning', 'critical', 'critical-ink'].map(token)) expect(deltaE(hue, status)).toBeGreaterThanOrEqual(15);
  });

  test("no identity hue is in the brand blue's family: each is at least 45° of hue from it", () => {
    for (const h of identity) expect(hueGap(h, token('brand'))).toBeGreaterThanOrEqual(45);
  });
});

describe('quantity is drawn apart from identity and brand', () => {
  test('the meter fill is a neutral, with too little chroma to read as an account or the brand', () => {
    expect(chroma(token('slate'))).toBeLessThan(0.04);
    for (const name of ['brand', 'id-1', 'id-2', 'id-3', 'id-4', 'id-5']) expect(chroma(token(name))).toBeGreaterThan(0.1);
  });
});
