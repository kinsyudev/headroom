import type { ActionInput, ActionKind, ActionOutput } from '../shared/actions';
import { DeckError } from '../shared/errors';
import { planMakePrimary } from '../shared/derive';
import type { AccountId, CpaAccount } from '../shared/domain';
import type { Claims } from './claims';
import type { Cpa } from './cpa';
import type { OAuthFlows } from './oauth';
import type { Observer } from './observer';
import type { Poller } from './poller';

export interface HandlerCtx {
  readonly cpa: Cpa;
  readonly observer: Observer;
  readonly poller: Poller;
  readonly claims: Claims;
  readonly oauth: OAuthFlows;
}

export type Handler<K extends ActionKind> = (input: ActionInput<K>, ctx: HandlerCtx) => Promise<ActionOutput<K>>;
export type Handlers = { readonly [K in ActionKind]: Handler<K> };

function known(ctx: HandlerCtx, id: AccountId): CpaAccount {
  const a = ctx.observer.accounts().find((x) => x.id === id);
  if (!a) throw new DeckError('unknown_account', `CPA has no Claude account ${id}`);
  return a;
}

export const handlers: Handlers = {
  'account.setDisabled': async ({ account, disabled }, ctx) => {
    known(ctx, account);
    await ctx.cpa.setDisabled(account, disabled);
    return { cpaAt: await ctx.observer.refresh() };
  },

  'account.setPriority': async ({ account, priority }, ctx) => {
    known(ctx, account);
    await ctx.cpa.setPriority(account, priority);
    return { cpaAt: await ctx.observer.refresh() };
  },

  'account.makePrimary': async ({ account }, ctx) => {
    await ctx.observer.refresh();
    const current = known(ctx, account);
    const plan = planMakePrimary(ctx.observer.accounts(), account);
    if (plan.enable) await ctx.cpa.setDisabled(account, false);
    if (plan.priority !== null) await ctx.cpa.setPriority(account, plan.priority);
    return {
      cpaAt: await ctx.observer.refresh(),
      priority: plan.priority ?? current.priority,
      changed: plan.priority !== null || plan.enable,
    };
  },

  'account.clearCooldown': async ({ account }, ctx) => {
    known(ctx, account);
    await ctx.cpa.clearCooldown(account);
    return { cpaAt: await ctx.observer.refresh() };
  },

  'account.refreshToken': async ({ account }, ctx) => {
    known(ctx, account);
    const { ok } = await ctx.cpa.refreshToken(account);
    return { ok, cpaAt: await ctx.observer.refresh() };
  },

  'routing.setStrategy': async ({ strategy }, ctx) => {
    await ctx.cpa.setStrategy(strategy);
    return { cpaAt: await ctx.observer.refresh() };
  },

  'quota.refresh': async ({ account }, ctx) => {
    if (account !== 'all') known(ctx, account);
    return { scheduled: ctx.poller.kick(account) };
  },

  'oauth.start': async (_input, ctx) => ctx.oauth.start(),

  'oauth.cancel': async ({ flow }, ctx) => {
    ctx.oauth.cancel(flow);
    return { ok: true };
  },

  claim: async ({ account, program, grant }, ctx) => {
    known(ctx, account);
    const record = await ctx.claims.claim({ account, program, grant });
    await ctx.observer.refresh();
    return record;
  },
};
