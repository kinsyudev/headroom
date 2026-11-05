import { useState, type ReactNode } from 'react';
import type { ActionInput, ActionKind, ActionOutput } from '../../shared/actions';
import { useAction, type ActionStatus } from '../api';
import { useNow, usePaused } from '../deck';

export const DONE_SHOWN_MS = 4_000;

export function ActionButton<K extends ActionKind>(props: {
  readonly kind: K;
  readonly input: ActionInput<K>;
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly done?: string | ((out: ActionOutput<K>) => string);
  readonly disabled?: boolean;
  /** Leaves the button out while what it does already holds, and keeps its feedback showing. */
  readonly hidden?: boolean;
  readonly title?: string;
  readonly variant?: 'quiet' | 'selected' | 'strong';
  readonly testId?: string;
}) {
  const a = useAction(props.kind);
  const paused = usePaused();
  const [doneText, setDoneText] = useState('Done');
  return (
    <span className="action">
      <button
        type="button"
        className={`btn ${props.variant ?? 'quiet'}`}
        hidden={props.hidden}
        disabled={props.disabled || a.pending || paused !== null}
        title={paused ?? props.title}
        aria-busy={a.pending}
        data-testid={props.testId}
        data-state={a.status.phase}
        data-paused={paused !== null || undefined}
        onClick={async () => {
          const out = await a.run(props.input);
          if (out !== undefined) setDoneText(typeof props.done === 'function' ? props.done(out) : (props.done ?? 'Done'));
        }}
      >
        {a.pending && <span className="spinner" aria-hidden />}
        {a.pending ? (props.pendingLabel ?? props.children) : props.children}
      </button>
      <ActionFeedback status={a.status} done={doneText} />
    </span>
  );
}

/** What became of an action: "✓ done" for a few seconds, or the error until the next try. pending: shown while it runs, for an action whose control has gone. */
export function ActionFeedback(props: { readonly status: ActionStatus; readonly done: string; readonly pending?: string }) {
  const now = useNow();
  const s = props.status;
  if (s.phase === 'pending' && props.pending)
    return (
      <span className="feedback" role="status">
        <span className="spinner" aria-hidden /> {props.pending}
      </span>
    );
  if (s.phase === 'ok' && now - s.at < DONE_SHOWN_MS)
    return (
      <span className="feedback ok" role="status">
        ✓ {props.done}
      </span>
    );
  if (s.phase === 'error')
    return (
      <span className="feedback error" role="alert" title={s.code}>
        ✕ {s.message}
      </span>
    );
  return null;
}
