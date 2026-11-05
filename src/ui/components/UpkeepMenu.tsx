import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AccountView } from '../../shared/view';
import { useAction, type ActionStatus } from '../api';
import { useNow, usePaused } from '../deck';
import { ActionFeedback } from './ActionButton';
import { Countdown } from './Countdown';
import { nextCheck } from './Freshness';

const REFRESH_HELD: Readonly<Record<NonNullable<AccountView['read']['refreshHeld']>['why'], { readonly short: string; readonly long: string }>> = {
  reading: { short: 'already checking', long: 'A check is already running' },
  rate_limited: { short: 'rate-limited', long: 'Rate-limited; waiting for the backoff' },
  capped: { short: 'check cap full', long: 'At most 8 checks per account in 15 minutes; waiting for the oldest to age out' },
  debounced: { short: 'once per minute', long: 'Once per minute per account' },
};

/**
 * One entry in the menu. run starts the action and resolves to what the feedback says once it is done, or undefined when it failed.
 * hidden: left out of the menu while it does not apply, and kept here so its feedback outlives it.
 */
interface Item {
  readonly testId: string;
  readonly label: ReactNode;
  readonly title: string;
  readonly hidden?: boolean;
  readonly unavailable: boolean;
  readonly destructive?: boolean;
  readonly status: ActionStatus;
  readonly pending: string;
  readonly run: () => Promise<string | undefined>;
}

/** The account actions an operator rarely needs, behind one More button: check now, refresh the token, and disable. */
export function UpkeepMenu(props: { readonly account: AccountView }) {
  const a = props.account;
  const now = useNow();
  const paused = usePaused();
  const check = useAction('quota.refresh');
  const token = useAction('account.refreshToken');
  const toggle = useAction('account.setDisabled');
  const [open, setOpen] = useState<'first' | 'last' | null>(null);
  const [chosen, setChosen] = useState<{ readonly testId: string; readonly done: string } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const held = a.read.refreshHeld;
  const items: Item[] = [
    {
      testId: 'refresh-quota',
      label: (
        <>
          ↻ Check now
          {(held?.why === 'debounced' || held?.why === 'capped') && held.until !== null && (
            <span className="muted">
              {' '}
              <Countdown at={held.until} />
            </span>
          )}
        </>
      ),
      title: [held === null ? 'Check Anthropic usage for this account now' : REFRESH_HELD[held.why].long, nextCheck(a, now)].filter(Boolean).join('\n'),
      unavailable: held !== null,
      status: check.status,
      pending: 'Queuing a check…',
      run: async () => {
        const o = await check.run({ account: a.id });
        return o && (o.scheduled[0]?.held ? `not queued: ${REFRESH_HELD[o.scheduled[0].held].short}` : 'check queued');
      },
    },
    {
      testId: 'refresh-token',
      label: 'Refresh token',
      title: "Ask CPA to renew this account's sign-in token now",
      unavailable: false,
      status: token.status,
      pending: 'Refreshing token…',
      run: async () => {
        const o = await token.run({ account: a.id });
        return o && (o.ok ? 'token refreshed' : 'CPA said not ok');
      },
    },
    {
      testId: 'toggle-disabled',
      label: 'Disable',
      title: 'Take this account out of rotation until you enable it again',
      hidden: !a.can.disable,
      unavailable: false,
      destructive: true,
      status: toggle.status,
      pending: 'Disabling…',
      run: async () => (await toggle.run({ account: a.id, disabled: true })) && 'disabled',
    },
  ];

  const entries = (): HTMLElement[] => (menu.current ? Array.from(menu.current.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []);
  useEffect(() => {
    if (open === null) return;
    const all = entries();
    (open === 'first' ? all[0] : all.at(-1))?.focus();
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  const move = (e: KeyboardEvent) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(null);
    }
  };
  const choose = async (item: Item) => {
    if (item.unavailable || paused !== null) return;
    close();
    setChosen({ testId: item.testId, done: 'Done' });
    const done = await item.run();
    if (done !== undefined) setChosen({ testId: item.testId, done });
  };

  const shown = items.find((i) => i.testId === chosen?.testId);
  return (
    <span className="upkeep-menu" ref={wrap}>
      {shown && chosen && <ActionFeedback status={shown.status} done={chosen.done} pending={shown.pending} />}
      <button
        ref={trigger}
        type="button"
        className="btn quiet"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open !== null ? id : undefined}
        aria-label={`More actions for ${a.email}`}
        title={paused === null ? 'Check now, refresh token, disable' : `${paused}: check now, refresh token, disable`}
        data-testid="more-actions"
        data-paused={paused !== null || undefined}
        onClick={() => (open === null ? setOpen('first') : setOpen(null))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(e.key === 'ArrowDown' ? 'first' : 'last');
          }
        }}
      >
        More <span aria-hidden>▾</span>
      </button>
      {open !== null && (
        <div className="menu" role="menu" id={id} aria-label={`More actions for ${a.email}`} ref={menu} onKeyDown={move}>
          {items.filter((item) => !item.hidden).map((item) => (
            <button
              key={item.testId}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.destructive ? 'menu-item destructive' : 'menu-item'}
              aria-disabled={item.unavailable || paused !== null || undefined}
              data-paused={paused !== null || undefined}
              title={paused ?? item.title}
              data-testid={item.testId}
              onClick={() => void choose(item)}
            >
              {item.label}
              {paused !== null && <span className="menu-paused">paused</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
