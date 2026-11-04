/**
 * One handler per row of ACTIONS (shared/actions.ts). The mapped type makes a missing or misspelled
 * handler a compile error.
 *
 * The pattern every CPA mutation follows (copy it):
 *   1. resolve and check the account (ctx.account(id) throws unknown_account)
 *   2. call the Cpa method
 *   3. `cpaAt: await ctx.observer.refreshCpa()`. The response is sent only after the new CPA state
 *      is published, so the UI never has to keep optimistic state.
 *
 * Handlers never write observations, claims, or flows directly. They call the owning module.
 */
import { planMakePrimary } from '../shared/derive';
import type { AccountId, CpaAccount } from '../shared/domain';
import type { ActionInput, ActionKind, ActionOutput } from '../shared/actions';
import type { Claims } from './claims';
import type { Cpa } from './cpa';
import type { OAuthFlows } from './oauth';
import type { Observer } from './observer';

export interface HandlerCtx {
  readonly cpa: Cpa;
  readonly observer: Observer;
  readonly claims: Claims;
  readonly oauth: OAuthFlows;
  /** The current CPA view of one account. Throws DeckError('unknown_account'). */
  account(id: AccountId): CpaAccount;
}

export type Handler<K extends ActionKind> = (input: ActionInput<K>, ctx: HandlerCtx) => Promise<ActionOutput<K>>;
export type Handlers = { readonly [K in ActionKind]: Handler<K> };

export const handlers: Handlers = {
  'account.setDisabled': async ({ account, disabled }, ctx) => {
    ctx.account(account);
    await ctx.cpa.setDisabled(account, disabled);
    return { cpaAt: await ctx.observer.refreshCpa() };
  },

  'account.setPriority': async ({ account, priority }, ctx) => {
    ctx.account(account);
    await ctx.cpa.setPriority(account, priority);
    return { cpaAt: await ctx.observer.refreshCpa() };
  },

  'account.makePrimary': async ({ account }, ctx) => {
    // TODO:
    // await ctx.observer.refreshCpa()   (plan against fresh priorities, not a 5 s old copy)
    // plan = planMakePrimary(accounts, account)
    // plan.enable → cpa.setDisabled(account, false)
    // plan.priority != null → cpa.setPriority(account, plan.priority)
    // return { cpaAt: await refreshCpa(), priority: plan.priority ?? current, changed: plan.priority != null || plan.enable }
    void planMakePrimary;
    throw new Error('not implemented');
  },

  'account.clearCooldown': async ({ account }, ctx) => {
    ctx.account(account);
    await ctx.cpa.clearCooldown(account);
    return { cpaAt: await ctx.observer.refreshCpa() };
  },

  'account.refreshToken': async ({ account }, ctx) => {
    ctx.account(account);
    const { ok } = await ctx.cpa.refreshToken(account); // token material was already dropped inside cpa.ts
    return { ok, cpaAt: await ctx.observer.refreshCpa() };
  },

  'routing.setStrategy': async ({ strategy }, ctx) => {
    await ctx.cpa.setStrategy(strategy);
    return { cpaAt: await ctx.observer.refreshCpa() };
  },

  'quota.refresh': async ({ account }, ctx) => {
    if (account !== 'all') ctx.account(account);
    return { scheduled: ctx.observer.kick(account) };
  },

  'oauth.start': async (_input, ctx) => ctx.oauth.start(),

  'oauth.cancel': async ({ flow }, ctx) => {
    ctx.oauth.cancel(flow);
    return { ok: true };
  },

  'claim.prepare': async ({ account, program, grant }, ctx) => {
    ctx.account(account);
    return ctx.claims.prepare({ account, program, grant });
  },

  'claim.confirm': async (input, ctx) => ctx.claims.confirm(input),
};
