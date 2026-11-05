import { usePaused } from '../deck';

export function ClaimButton(props: { readonly name: string; readonly short: string; readonly email: string; readonly testId: string; readonly onClick: () => void }) {
  const paused = usePaused();
  return (
    <button
      type="button"
      className="btn accent"
      onClick={props.onClick}
      disabled={paused !== null}
      title={paused ?? undefined}
      aria-label={`Claim “${props.name}” on ${props.email}`}
      data-testid={props.testId}
      data-paused={paused !== null || undefined}
    >
      Claim {props.short}…
    </button>
  );
}
