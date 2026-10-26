/** Read persisted tour completion as well as the settings flag so quitting before settings save cannot replay a completed
 * tour. */
import type { AveApi } from "../types.js";

/** Canonical id of the first-login tour scenario. Must match the scenario registered in `default-tour-scenarios.ts`
 * (`first-boot-essentials`). Centralised here so the gate and any future caller share one literal. */
export const FIRST_BOOT_SCENARIO_ID = "first-boot-essentials";

/** The shape `api.tour.getState()` resolves to, plus `null` for IPC failure. */
export type TourStateResult = Awaited<ReturnType<AveApi["tour"]["getState"]>> | null;

/**
 * True iff the tour-state result shows the user has completed the
 * first-boot tour. Must defend the full union: `result` may be `null`
 * (IPC threw), `{ ok: false, ... }` (host returned an error), or
 * `{ ok: true, state: { completedScenarios: string[], ... } }`. Only the
 * `ok: true` branch exposes `state.completedScenarios`.
 */
export function hasSeenFirstBootTour(result: TourStateResult): boolean {
  return (
    result?.ok === true &&
    result.state.completedScenarios.includes(FIRST_BOOT_SCENARIO_ID)
  );
}
