import type { ClaimRecord, Money, Percent, SourceError } from '../shared/domain';
import { clearsText } from '../shared/derive';

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

export function percent(p: Percent | number | null): string {
  if (p === null) return '—';
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function money(m: Money): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency: m.currency }).format(m.minor / 10 ** m.exponent);
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
    case 'unavailable':
      return `Anthropic answered ${o.result}${o.reason ? ` (${o.reason})` : ''}. Nothing consumed.`;
    case 'rate_limited':
      return 'Anthropic rate-limited the request. Nothing consumed; try again later.';
    case 'auth_error':
      return `Anthropic refused the token (${o.status}). Nothing consumed; try Refresh token.`;
    case 'not_sent':
      return `Not sent: ${o.why}. Nothing consumed.`;
  }
}
