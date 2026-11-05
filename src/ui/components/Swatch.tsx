import type { ReactElement } from 'react';
import type { AccountId } from '../../shared/domain';

/** An account's place in the identity order. Its colour and its marker shape both follow it, so no account is told apart by colour alone. */
export type Slot = 1 | 2 | 3 | 4 | 5;

const ORDER: readonly Slot[] = [1, 2, 3, 4, 5];

const SHAPE: Readonly<Record<Slot, { readonly name: string; readonly path: ReactElement }>> = {
  1: { name: 'square', path: <rect x="1" y="1" width="8" height="8" rx="1.5" /> },
  2: { name: 'circle', path: <circle cx="5" cy="5" r="4.6" /> },
  3: { name: 'diamond', path: <path d="M5 0 10 5 5 10 0 5Z" strokeLinejoin="round" /> },
  4: { name: 'triangle', path: <path d="M5 .6 9.8 9.2H.2Z" strokeLinejoin="round" /> },
  5: { name: 'ring', path: <path d="M5 .4a4.6 4.6 0 1 0 0 9.2A4.6 4.6 0 1 0 5 .4Zm0 2.4a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 1 1 0-4.4Z" fillRule="evenodd" /> },
};

/** Every account's slot, in the deck's order and wrapping after five. Built once from all accounts, so a filter never moves one. */
export function slotsOf(ids: readonly AccountId[]): ReadonlyMap<AccountId, Slot> {
  return new Map(ids.map((id, i) => [id, ORDER[i % ORDER.length]!]));
}

export const slotColor = (slot: Slot): string => `var(--id-${slot})`;

/** The one mark for an account wherever it is named: its colour in its shape. With no slot it holds the same room, empty. */
export function Swatch(props: { readonly slot: Slot | undefined }) {
  const shape = props.slot === undefined ? undefined : SHAPE[props.slot];
  return (
    <svg className="swatch" viewBox="0 0 10 10" fill={props.slot === undefined ? 'none' : slotColor(props.slot)} data-shape={shape?.name} aria-hidden>
      {shape?.path}
    </svg>
  );
}
