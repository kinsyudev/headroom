import { useState } from 'react';
import type { AccountId } from '../../shared/domain';
import type { RoutingView } from '../../shared/view';
import { useAction } from '../api';
import { useNow, usePaused } from '../deck';
import { DONE_SHOWN_MS } from './ActionButton';

export function PriorityStepper(props: { readonly account: AccountId; readonly routing: RoutingView }) {
  const set = useAction('account.setPriority');
  const now = useNow();
  const paused = usePaused();
  const [clicked, setClicked] = useState<string | null>(null);
  const { priority, stepTo } = props.routing;
  const saved = set.status.phase === 'ok' && now - set.status.at < DONE_SHOWN_MS;
  const button = (testId: string, glyph: string, to: number | null, label: string, atBound: string) => (
    <button
      type="button"
      className="step"
      disabled={to === null || set.pending || paused !== null}
      title={paused ?? (to === null ? atBound : label)}
      aria-label={to === null ? atBound : label}
      data-testid={testId}
      data-state={clicked === testId ? set.status.phase : 'idle'}
      onClick={() => {
        if (to === null) return;
        setClicked(testId);
        void set.run({ account: props.account, priority: to });
      }}
    >
      {glyph}
    </button>
  );
  return (
    <span className="action">
      <span className="stepper" role="group" aria-label="Priority" aria-busy={set.pending} data-state={set.status.phase}>
        <span className="stepper-label">Priority</span>
        <span className="stepper-box">
          {button('priority-down', '−', stepTo.down, `Lower priority to ${stepTo.down}`, 'Already at the lowest priority')}
          <span className="stepper-value num" data-testid="priority" data-saved={saved}>
            {priority}
          </span>
          {button('priority-up', '+', stepTo.up, `Raise priority to ${stepTo.up}`, 'Already at the highest priority')}
        </span>
      </span>
      {set.status.phase === 'error' && (
        <span className="feedback error" role="alert" title={set.status.code}>
          ✕ {set.status.message}
        </span>
      )}
    </span>
  );
}
