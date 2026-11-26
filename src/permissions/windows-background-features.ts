import type { SessionSearchIndexPolicy } from "../memory/session-search-index.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../shared/ave-home.js";
import { isOfflineProcessConfinementActive } from "./asrt-sandbox.js";
import { hasMxcReleaseGateEvidence } from "./mxc-extension-admission.js";
import { getWindowsExtensionBackendPlan, getWindowsSandboxSubstrate, isSandboxGateUndecidedAtBoot } from "./sandbox-capability.js";

export function isWindowsBackgroundFeatureReleaseEnabled(): boolean {
  return process.platform === "win32" && hasMxcReleaseGateEvidence();
}

export function areWindowsBackgroundSwitchesAvailable(): boolean {
  if (!isWindowsBackgroundFeatureReleaseEnabled() || isSandboxGateUndecidedAtBoot() || !isAveHomePrivacyVerifiedAtBoot()
    || isOfflineProcessConfinementActive()) return false;
  const substrate = getWindowsSandboxSubstrate();
  const plan = getWindowsExtensionBackendPlan();
  if (plan?.selectedBackend !== "none" || substrate?.accountBackendAbsent !== true || substrate.srtWinReady !== false
    || substrate.mxc.state !== "unavailable" || substrate.mxc.reason !== "container-unavailable"
    || substrate.mxc.containerBackendAbsent !== true) return false;
  return plan.readiness === "off" || (plan.readiness === "unavailable"
    && (plan.reason === substrate.mxc.reason || plan.reason === "native-validation-required"));
}

export function sessionSearchIndexPolicy(preference: boolean | undefined): SessionSearchIndexPolicy {
  if (isWindowsBackgroundFeatureReleaseEnabled() && isSandboxGateUndecidedAtBoot()) return "pending";
  return preference === false && areWindowsBackgroundSwitchesAvailable() ? "paused" : "enabled";
}
