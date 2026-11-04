/** Display formatting only. No domain decisions: if you're about to compare against a threshold here, it belongs in derive.ts. */
import type { Money, Percent } from '../shared/domain';

/** 6845000 → "1h 54m"; 41000 → "41s"; 3.5 days → "3d 12h". Negative → "now". */
export function duration(ms: number): string {
  throw new Error('not implemented');
}

/** Local wall time; adds the weekday if not today. "15:20", "Thu 09:00". */
export function clockTime(at: number, now: number): string {
  throw new Error('not implemented');
}

export function percent(p: Percent | null): string {
  throw new Error('not implemented');
}

/** 1234567 → "1.2M". */
export function tokens(n: number): string {
  throw new Error('not implemented');
}

/** { minor: 10100, exponent: 2, currency: 'USD' } → "$101.00". */
export function money(m: Money): string {
  throw new Error('not implemented');
}
