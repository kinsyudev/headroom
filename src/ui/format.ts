import type { ClaimRecord, Money, PercentLeft, SourceError } from '../shared/domain';
import { clearsText, INELIGIBLE_EXPLAIN, REASON_TEXT } from '../shared/derive';
import type { Grain } from '../shared/view';

const CLAIM_RESULT: Readonly<Record<string, string>> = {
  already_used: 'already used this week',
  not_limited: 'the account was not limited',
  cooldown: 'on cooldown',
  ineligible: 'not eligible',
  unavailable: 'unavailable',
  rate_limited: 'rate-limited',
  auth_error: 'token refused',
  not_sent: 'not sent',
};

export const reasonText = (code: string): string => REASON_TEXT[code] ?? code;

export function reasonTitle(code: string): string {
  const text = reasonText(code);
  return text === code ? code : `${text} (${code})`;
}

export const claimResultText = (result: string): string => CLAIM_RESULT[result] ?? result;

export function duration(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function clockTime(at: number, now: number): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  if (Math.abs(at - now) < 6 * 86_400_000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

/** The one place a column says which way its figures run: the header, the narrow row label and the meter's name. */
export const leftLabel = (window: string): string => `${window} left`;

/** How the serve order works, in the one wording the Serve order heading and every Priority label use. */
export const SERVE_ORDER_HELP =
  'Fill-first sends each new session to the highest-priority account that can take it, so 1 in the serve order takes the next one. Serve first and the priority buttons move an account up or down the order. Blocked and disabled accounts take nothing until they are back. Round-robin ignores priority and takes turns.';

/** What the pace tick on a quota meter means, in the one wording every place that explains it uses. */
export const PACE_TICK_HELP =
  'The bar is what is left. The tick is where it would stand if you used the window evenly. A fill that ends left of the tick means you are using it faster than that.';

/** What one line says for an account's folded quota windows, given how many last to the reset and how many are too early to say. */
export function foldedPaceSays(lasts: number, early: number): string {
  const only = (n: number, one: string, many: string) => (n === 1 ? one : n === 2 ? `Both ${many}` : `All ${n} ${many}`);
  if (early === 0) return only(lasts, 'Lasts to the reset', 'last to the reset');
  if (lasts === 0) return only(early, 'Too early to say', 'too early to say');
  return `${lasts} ${lasts === 1 ? 'lasts' : 'last'} to the reset, ${early} too early to say`;
}

export function percent(p: PercentLeft | null): string {
  if (p === null) return '—';
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 640 below a thousand and one decimal above, 2.0M beside 1.4M, so a column of them reads at one precision. */
export function compact(n: number): string {
  const whole = Math.round(n);
  return Math.abs(whole) < 1000 ? String(whole) : COMPACT.format(whole);
}

/** The name an account goes by in a table, a legend or a tooltip, with its colour square beside it: "account1" for account1@example.com. */
export const shortName = (email: string): string => email.split('@')[0]!;

/** A moment with its date, the way a chart axis dates it: "Nov 4 19:25". */
export function stamp(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

/** A whole amount drops its cents, so a cap and what is left of it fit the narrow Extra usage column. */
export function money(m: Money): string {
  const whole = m.minor % 10 ** m.exponent === 0;
  return new Intl.NumberFormat('en', { style: 'currency', currency: m.currency, minimumFractionDigits: whole ? 0 : undefined }).format(m.minor / 10 ** m.exponent);
}

export function sourceError(e: SourceError): string {
  switch (e.kind) {
    case 'rate_limited':
      return 'rate-limited';
    case 'read_cap':
      return 'read cap full';
    case 'auth':
      return `Anthropic auth ${e.status}`;
    case 'cpa_unreachable':
      return 'CPA not answering';
    case 'link_down':
      return 'management link down';
    case 'upstream':
      return e.status === 0 ? e.message : `upstream ${e.status}${e.message ? `: ${e.message}` : ''}`;
    case 'malformed':
      return `unreadable: ${e.message}`;
    case 'unavailable':
      return e.message;
  }
}

export function claimText(r: ClaimRecord): string {
  const s = r.state;
  if (s.kind === 'sending') return 'Claiming…';
  if (s.kind === 'maybe_sent') return `Outcome unknown (${s.why}). Checking on the next read; it will not be resent.`;
  const o = s.outcome;
  const followup =
    s.followup === 'done' ? ' CPA cooldown cleared.' : s.followup === 'failed' ? " CPA's cooldown was not cleared; use Clear cooldown." : '';
  switch (o.result) {
    case 'reset':
      return `Reset. Cleared ${clearsText(o.cleared.length ? o.cleared : ['five_hour'])}${o.resetsLeft !== null ? `, ${o.resetsLeft} left` : ''}.${followup}`;
    case 'not_limited':
      return `The account was not limited, so nothing was consumed.${followup}`;
    case 'already_used':
      return `Already used this week${o.nextAvailableAt ? `; next ${new Date(o.nextAvailableAt).toLocaleString()}` : ''}.`;
    case 'cooldown':
      return `On cooldown${o.nextAvailableAt ? ` until ${new Date(o.nextAvailableAt).toLocaleString()}` : ''}. Nothing consumed.`;
    case 'ineligible':
    case 'unavailable': {
      const why = o.reason ? ` ${INELIGIBLE_EXPLAIN[o.reason] ?? `Reason: ${o.reason}.`}` : '';
      return `Anthropic answered ${o.result}.${why} Nothing consumed.`;
    }
    case 'rate_limited':
      return 'Anthropic rate-limited the request. Nothing consumed; try again later.';
    case 'auth_error':
      return `Anthropic refused the token (${o.status}). Nothing consumed; try Refresh token.`;
    case 'not_sent':
      return `Not sent: ${o.why}. Nothing consumed.`;
  }
}

/** "claude-opus-5-5" reads as "Opus 5.5". An id that does not follow the pattern is shown as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (!m) return id;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** A share between 0 and 1, as a percent with one decimal below 10 and none above, so 96.6% and 87% both read at a glance. */
export function share(n: number | null, digits?: number): string {
  if (n === null) return '—';
  const p = n * 100;
  if (p === 0) return '0%';
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(digits ?? (p < 10 || (p >= 90 && p < 99.95) ? 1 : 0))}%`;
}

/** 1,284 below 10,000 and 12.9K above, so a tile and an axis agree on what a count looks like. */
export function count(n: number): string {
  return n < 10_000 ? Math.round(n).toLocaleString('en') : compact(n);
}

export function seconds(ms: number | null): string {
  return ms === null ? '—' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const weekdayName = (weekday: number, style: 'long' | 'short' = 'long'): string => (style === 'long' ? WEEKDAYS[weekday]! : WEEKDAYS[weekday]!.slice(0, 3));

export const hourText = (hour: number): string => `${String(hour % 24).padStart(2, '0')}:00`;

/** A change as a fraction of what it was: 0.193 is "19%". Null when there was nothing to compare against. */
export function changeText(change: number | null): string {
  if (change === null) return '—';
  const p = Math.abs(change) * 100;
  return `${p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly partial: boolean;
}

/** How a time bucket reads on an axis, in a tooltip title, and as a table row. The bucket still filling says "now". */
export function bucketText(grain: Grain, now: number) {
  const span = (b: Span) =>
    grain === 'hour' ? `${clockTime(b.start, now)}–${clockTime(b.end, now)}` : new Date(b.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return {
    label: (b: Span) => {
      if (b.partial) return 'now';
      return grain === 'hour' ? new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : new Date(b.start).toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    span,
    title: (b: Span) => (b.partial ? `${span(b)} · in progress` : span(b)),
  };
}
