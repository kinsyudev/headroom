/**
 * The action table: every mutation the deck can perform, as one list.
 *
 * Everything else is derived from ACTIONS:
 * - the `Action` union and per-kind input and output types (below),
 * - the request parser in server/http.ts (`ACTIONS[kind].input.parse(body.input)`),
 * - the handler table in server/handlers.ts, typed `{ [K in ActionKind]: Handler<K> }`, so a missing
 *   handler fails the build,
 * - the UI's `act(kind, input)` and `useAction(kind)` (ui/api.ts).
 *
 * To add an action: add a row here, then add the handler the compiler asks for. That's all.
 *
 * Inputs are zod schemas because they are parsed from untrusted request bodies. Outputs are phantom
 * types (`out<T>()`) because the server constructs them.
 */
import { z } from 'zod';
import type { AccountId, FlowId, GrantId, Instant, ProgramId, RoutingStrategy } from './domain';

const out = <T>() => undefined as unknown as T;

const accountId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .transform((s) => s as AccountId);
const program = z.enum(['juniper_tide', 'cedar_ember']).transform((p) => p as ProgramId);
const grantId = z
  .string()
  .min(1)
  .max(128)
  .transform((s) => s as GrantId);
const flowId = z
  .string()
  .uuid()
  .transform((s) => s as FlowId);

/** Returned by every CPA mutation. When the promise resolves, the server has already re-read CPA. */
export interface Applied {
  readonly cpaAt: Instant;
}

export const ACTIONS = {
  'account.setDisabled': { input: z.object({ account: accountId, disabled: z.boolean() }), output: out<Applied>() },
  'account.setPriority': {
    input: z.object({ account: accountId, priority: z.number().int().min(0).max(1000) }),
    output: out<Applied>(),
  },
  'account.makePrimary': { input: z.object({ account: accountId }), output: out<Applied & { priority: number; changed: boolean }>() },
  'account.clearCooldown': { input: z.object({ account: accountId }), output: out<Applied>() },
  /** The CPA response holds tokens. Handlers return only this. */
  'account.refreshToken': { input: z.object({ account: accountId }), output: out<Applied & { ok: boolean }>() },
  'routing.setStrategy': {
    input: z.object({ strategy: z.enum(['fill-first', 'round-robin']).transform((s) => s as RoutingStrategy) }),
    output: out<Applied>(),
  },
  /** Moves the next Anthropic poll earlier. Never bypasses rate-limit backoff. */
  'quota.refresh': {
    input: z.object({ account: z.union([accountId, z.literal('all')]) }),
    output: out<{ scheduled: readonly { account: AccountId; at: Instant; held: 'debounced' | 'rate_limited' | null }[] }>(),
  },
  'oauth.start': { input: z.object({}), output: out<{ flow: FlowId; url: string }>() },
  'oauth.cancel': { input: z.object({ flow: flowId }), output: out<{ ok: true }>() },
} as const;

export type ActionKind = keyof typeof ACTIONS;
export type ActionInput<K extends ActionKind> = z.output<(typeof ACTIONS)[K]['input']>;
export type ActionOutput<K extends ActionKind> = (typeof ACTIONS)[K]['output'];
export type Action = { [K in ActionKind]: { readonly kind: K; readonly input: ActionInput<K> } }[ActionKind];

// ---------------------------------------------------------------------------------------------
// Errors: one class on both sides. The server throws it, http.ts serializes it, and the UI rethrows it.
// ---------------------------------------------------------------------------------------------

export type DeckErrorCode =
  | 'invalid' // request body failed the schema
  | 'unknown_account'
  | 'link_down' // management key missing, rejected, or guarded. Nothing was sent.
  | 'cpa_unreachable'
  | 'cpa_error' // CPA answered non-2xx (other than auth)
  | 'not_claimable' // preflight says no; message says why
  | 'flow_busy';

/** HTTP status per code, so http.ts has no switch of its own. */
export const DECK_ERROR_STATUS: Readonly<Record<DeckErrorCode, number>> = {
  invalid: 400,
  unknown_account: 404,
  link_down: 503,
  cpa_unreachable: 502,
  cpa_error: 502,
  not_claimable: 409,
  flow_busy: 409,
};

export class DeckError extends Error {
  constructor(
    readonly code: DeckErrorCode,
    message: string,
  ) {
    super(message);
  }
}
