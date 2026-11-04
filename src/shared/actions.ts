/**
 * Every mutation the deck can perform, as one table. The input and output types, the request
 * parser (http.ts), the handler map (handlers.ts, where a missing row fails the build) and the
 * UI's `act()` all derive from ACTIONS. Inputs are zod schemas because they come from request
 * bodies; outputs are phantom types because the server builds them.
 */
import { z } from 'zod';
import type { AccountId, ClaimRecord, FlowId, GrantId, Instant, ProgramId, RoutingStrategy } from './domain';

const out = <T>() => undefined as unknown as T;

const accountId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .transform((s) => s as AccountId);

/** Every CPA mutation resolves only after the server has re-read CPA. */
export interface Applied {
  readonly cpaAt: Instant;
}

export type RefreshHeld = 'debounced' | 'rate_limited' | 'reading';

export const ACTIONS = {
  'account.setDisabled': { input: z.object({ account: accountId, disabled: z.boolean() }), output: out<Applied>() },
  'account.setPriority': {
    input: z.object({ account: accountId, priority: z.number().int().min(0).max(1000) }),
    output: out<Applied>(),
  },
  'account.makePrimary': { input: z.object({ account: accountId }), output: out<Applied & { priority: number; changed: boolean }>() },
  'account.clearCooldown': { input: z.object({ account: accountId }), output: out<Applied>() },
  'account.refreshToken': { input: z.object({ account: accountId }), output: out<Applied & { ok: boolean }>() },
  'routing.setStrategy': {
    input: z.object({ strategy: z.enum(['fill-first', 'round-robin']).transform((s) => s as RoutingStrategy) }),
    output: out<Applied>(),
  },
  /** Moves the next Anthropic read to now. Never bypasses backoff. */
  'quota.refresh': {
    input: z.object({ account: z.union([accountId, z.literal('all')]) }),
    output: out<{ scheduled: readonly { account: AccountId; held: RefreshHeld | null }[] }>(),
  },
  'oauth.start': { input: z.object({}), output: out<{ flow: FlowId; url: string }>() },
  'oauth.cancel': { input: z.object({ flow: z.uuid().transform((s) => s as FlowId) }), output: out<{ ok: true }>() },
  /**
   * Claims a Claude reset. IRREVERSIBLE. The server reads fresh `wall` data first and refuses
   * with `not_claimable` unless that read says the offer is claimable. A second call while one is
   * in flight for the same account and program gets the same result back.
   */
  claim: {
    input: z.object({
      account: accountId,
      program: z.enum(['juniper_tide', 'cedar_ember']).transform((p) => p as ProgramId),
      grant: z
        .string()
        .min(1)
        .max(128)
        .transform((s) => s as GrantId)
        .optional(),
    }),
    output: out<ClaimRecord>(),
  },
} as const;

export type ActionKind = keyof typeof ACTIONS;
export type ActionInput<K extends ActionKind> = z.output<(typeof ACTIONS)[K]['input']>;
export type ActionOutput<K extends ActionKind> = (typeof ACTIONS)[K]['output'];

export type DeckErrorCode =
  | 'invalid'
  | 'unknown_account'
  /** Management key missing or rejected. Nothing was sent. */
  | 'link_down'
  | 'cpa_unreachable'
  | 'cpa_error'
  | 'not_claimable'
  | 'unavailable';

export const DECK_ERROR_STATUS: Readonly<Record<DeckErrorCode, number>> = {
  invalid: 400,
  unknown_account: 404,
  link_down: 503,
  cpa_unreachable: 502,
  cpa_error: 502,
  not_claimable: 409,
  unavailable: 503,
};

/** One error class on both sides: the server throws it, http.ts serializes it, the UI rethrows it. */
export class DeckError extends Error {
  constructor(
    readonly code: DeckErrorCode,
    message: string,
  ) {
    super(message);
  }
}
