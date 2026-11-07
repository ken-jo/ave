/** Persisted completion or dismissal suppresses automatic first-boot help. */
import type { AveApi } from "../types.js";
import { FIRST_BOOT_SCENARIO_ID } from "../../../shared/first-boot-tour.js";

/** The shape `api.tour.getState()` resolves to, plus `null` for IPC failure. */
export type TourStateResult = Awaited<ReturnType<AveApi["tour"]["getState"]>> | null;

/**
 * True iff the tour-state result shows the user has completed or dismissed the
 * first-boot tour. Must defend the full union: `result` may be `null`
 * (IPC threw), `{ ok: false, ... }` (host returned an error), or
 * `{ ok: true, state: { completedScenarios: string[], ... } }`. Only the
 * `ok: true` branch exposes `state.completedScenarios`.
 */
export function hasSeenFirstBootTour(result: TourStateResult): boolean {
  return (
    result?.ok === true &&
    (result.state.completedScenarios.includes(FIRST_BOOT_SCENARIO_ID) ||
      (result.state.lastSeenScenario === FIRST_BOOT_SCENARIO_ID && result.state.dismissedAt !== null))
  );
}
