




// Share gate reason vocabulary with the renderer so diagnostics describe the same outcome.
export type {
  SandboxGateAction,
  SandboxGateReason,
} from "../../shared/sandbox-capability-info.js";

import type {
  SandboxGateAction,
  SandboxGateReason,
} from "../../shared/sandbox-capability-info.js";

export interface SandboxGateInputs {
  /** `features.osToolSandbox` OR `features.pluginWorkerConfinement`; a Settings toggle of either scope; the shell
   * scope is on by default on macOS/Linux and gated off on Windows, the worker scope off by default everywhere. */
  settingOn: boolean;
  /** `AVE_SANDBOX_ENABLED=1` OR `AVE_PLUGIN_WORKER_CONFINEMENT=1`; the deliberate, fail-closed env override of either scope. */
  explicitEnv: boolean;
  platform: NodeJS.Platform;
  /** Whether the sandbox CAN activate; `checkAsrtDependencies().errors.length === 0` (or, on the init-failure re-check, `false`). */
  depsOk: boolean;
}

export interface SandboxGateDecision {
  action: SandboxGateAction;
  reason: SandboxGateReason;
}

/** Gate decisions depend only on supplied inputs, with no environment reads or side effects. */
export function decideSandboxGate(input: SandboxGateInputs): SandboxGateDecision {
  const optIn = input.settingOn || input.explicitEnv;
  if (!optIn) {
    return { action: "skip", reason: "gate-off" };
  }
  if (input.depsOk) {
    return { action: "activate", reason: "deps-present" };
  }
  if (input.platform === "win32") {
    // Windows setup requires the UI; unavailable confinement must warn rather than abort even after explicit activation.
    return { action: "degrade", reason: "degrade-windows-not-installed" };
  }
  if (input.explicitEnv) {
    return { action: "abort", reason: "abort-explicit-cannot-activate" };
  }
  return { action: "degrade", reason: "degrade-default-cannot-activate" };
}

/** Host risk classification cannot contain direct filesystem, network, or detached mutations outside HostApi.
 * Warn whenever OS confinement is inactive, including failed settings activation. */
export function shouldWarnHostClassifyInterlock(input: {
  hostClassifiesRisk: boolean;
  sandboxActive: boolean;
}): boolean {
  return input.hostClassifiesRisk && !input.sandboxActive;
}
