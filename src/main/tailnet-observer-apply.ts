import type { TailnetObserverApplyStatus, TailnetObserverPortBlock } from "../shared/tailnet-observer-config.js";

interface TailnetObserverApplyState {
  readonly boundPort: number | null;
  readonly boundNow?: boolean;
  readonly portBlock: TailnetObserverPortBlock | null;
  readonly lastStartError: string | null;
}

export function resolveTailnetObserverApply(
  savedEnabled: boolean,
  enableOverride: boolean | undefined,
  effectivePort: number | null,
  { boundPort, boundNow, portBlock, lastStartError }: TailnetObserverApplyState,
): { readonly status: TailnetObserverApplyStatus; readonly portBlock: TailnetObserverPortBlock | null; readonly lastStartError: string | null } {
  const observerOff = !savedEnabled && enableOverride !== true && boundPort === null;
  const failure = observerOff || boundNow ? { portBlock: null, lastStartError: null } : { portBlock, lastStartError };
  if (observerOff) {
    return { status: { outcome: "observer-off", restartNeeded: false }, ...failure };
  }

  if (effectivePort === null || effectivePort !== boundPort) {
    return { status: { outcome: "restart-needed", restartNeeded: true }, ...failure };
  }

  return { status: { outcome: savedEnabled ? "applied" : "saved", restartNeeded: false }, ...failure };
}
