import { z } from 'zod';
import type { AccountId, ClaimRecord, FlowId, GrantId, Instant, ProgramId, RoutingStrategy } from './domain';

const out = <T>() => undefined as unknown as T;

const accountId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .transform((s) => s as AccountId);

export interface Applied {
  readonly cpaAt: Instant;
}

export type RefreshHeld = 'debounced' | 'rate_limited' | 'capped' | 'reading';

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
  'quota.refresh': {
    input: z.object({ account: z.union([accountId, z.literal('all')]) }),
    output: out<{ scheduled: readonly { account: AccountId; held: RefreshHeld | null }[] }>(),
  },
  'oauth.start': { input: z.object({}), output: out<{ flow: FlowId; url: string }>() },
  'oauth.cancel': { input: z.object({ flow: z.uuid().transform((s) => s as FlowId) }), output: out<{ ok: true }>() },
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
