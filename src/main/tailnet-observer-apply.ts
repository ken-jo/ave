import type { TailnetObserverApplyStatus, TailnetObserverPortBlock } from "../shared/tailnet-observer-config.js";

export function resolveTailnetObserverApply(
  savedEnabled: boolean,
  enableOverride: boolean | undefined,
  effectivePort: number | null,
  boundPort: number | null,
  priorPortBlock: TailnetObserverPortBlock | null,
): { readonly status: TailnetObserverApplyStatus; readonly portBlock: TailnetObserverPortBlock | null } {
  if (!savedEnabled && enableOverride !== true && boundPort === null) {
    return { status: { outcome: "observer-off", restartNeeded: false }, portBlock: null };
  }

  if (effectivePort === null || effectivePort !== boundPort) {
    return { status: { outcome: "restart-needed", restartNeeded: true }, portBlock: priorPortBlock };
  }

  return { status: { outcome: savedEnabled ? "applied" : "saved", restartNeeded: false }, portBlock: priorPortBlock };
}
