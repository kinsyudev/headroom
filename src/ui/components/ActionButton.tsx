import { useState, type ReactNode } from 'react';
import type { ActionInput, ActionKind, ActionOutput } from '../../shared/actions';
import { useAction } from '../api';
import { useNow, usePaused } from '../deck';

const DONE_SHOWN_MS = 4_000;

export function ActionButton<K extends ActionKind>(props: {
  readonly kind: K;
  readonly input: ActionInput<K>;
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly done?: string | ((out: ActionOutput<K>) => string);
  readonly disabled?: boolean;
  readonly title?: string;
  readonly variant?: 'primary' | 'quiet' | 'danger';
  readonly testId?: string;
}) {
  const a = useAction(props.kind);
  const now = useNow();
  const paused = usePaused();
  const [doneText, setDoneText] = useState('Done');
  return (
    <span className="action">
      <button
        type="button"
        className={`btn ${props.variant ?? 'quiet'}`}
        disabled={props.disabled || a.pending || paused !== null}
        title={paused ?? props.title}
        aria-busy={a.pending}
        data-testid={props.testId}
        data-state={a.status.phase}
        onClick={async () => {
          const out = await a.run(props.input);
          if (out !== undefined) setDoneText(typeof props.done === 'function' ? props.done(out) : (props.done ?? 'Done'));
        }}
      >
        {a.pending && <span className="spinner" aria-hidden />}
        {a.pending ? (props.pendingLabel ?? props.children) : props.children}
      </button>
      {a.status.phase === 'ok' && now - a.status.at < DONE_SHOWN_MS && (
        <span className="feedback ok" role="status">
          ✓ {doneText}
        </span>
      )}
      {a.status.phase === 'error' && (
        <span className="feedback error" role="alert" title={a.status.code}>
          ✕ {a.status.message}
        </span>
      )}
    </span>
  );
}
