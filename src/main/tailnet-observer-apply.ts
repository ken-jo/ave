import type { TailnetObserverApplyStatus, TailnetObserverPortBlock } from "../shared/tailnet-observer-config.js";

interface TailnetObserverApplyState {
  readonly boundPort: number | null;
  readonly boundNow?: boolean;
  readonly startupFailed?: boolean;
  readonly portBlock: TailnetObserverPortBlock | null;
  readonly lastStartError: string | null;
}

export function resolveTailnetObserverApply(
  savedEnabled: boolean,
  enableOverride: boolean | undefined,
  effectivePort: number | null,
  { boundPort, boundNow, startupFailed, portBlock, lastStartError }: TailnetObserverApplyState,
): { readonly status: TailnetObserverApplyStatus; readonly portBlock: TailnetObserverPortBlock | null; readonly lastStartError: string | null } {
  const observerOff = !startupFailed && !savedEnabled && enableOverride !== true && boundPort === null;
  const clearDiagnostics = !startupFailed && (observerOff || boundNow);
  const diagnostics = clearDiagnostics ? { portBlock: null, lastStartError: null } : { portBlock, lastStartError };
  if (observerOff) {
    return { status: { outcome: "observer-off", restartNeeded: false }, ...diagnostics };
  }

  if (startupFailed || effectivePort === null || effectivePort !== boundPort) {
    return { status: { outcome: "restart-needed", restartNeeded: true }, ...diagnostics };
  }

  return { status: { outcome: savedEnabled ? "applied" : "saved", restartNeeded: false }, ...diagnostics };
}
