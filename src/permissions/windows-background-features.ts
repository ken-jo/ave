import { isAveHomePrivacyVerifiedAtBoot } from "../shared/ave-home.js";
import type { SandboxMxcUnavailableReason } from "../shared/sandbox-capability-info.js";
import { isOfflineProcessConfinementActive } from "./asrt-sandbox.js";
import { hasMxcReleaseGateEvidence } from "./mxc-extension-admission.js";
import { getWindowsExtensionBackendPlan, getWindowsSandboxSubstrate } from "./sandbox-capability.js";

export function isWindowsBackgroundFeatureReleaseEnabled(): boolean {
  return process.platform === "win32" && hasMxcReleaseGateEvidence();
}

function isWindowsBackgroundContainerAbsent(reason: SandboxMxcUnavailableReason): boolean {
  return reason === "unsupported-arch" || reason === "binary-missing" || reason === "container-unavailable";
}

export function areWindowsBackgroundSwitchesAvailable(): boolean {
  if (!isWindowsBackgroundFeatureReleaseEnabled() || !isAveHomePrivacyVerifiedAtBoot()
    || isOfflineProcessConfinementActive()) return false;
  const substrate = getWindowsSandboxSubstrate();
  const plan = getWindowsExtensionBackendPlan();
  if (plan?.selectedBackend !== "none" || substrate?.srtWinReady !== false || substrate.mxc.state !== "unavailable") return false;
  const { reason } = substrate.mxc;
  return isWindowsBackgroundContainerAbsent(reason)
    && (plan.readiness === "off" || (plan.readiness === "unavailable"
      && (plan.reason === reason || plan.reason === "native-validation-required")));
}

export function isSessionIndexingEnabled(preference: boolean | undefined): boolean {
  if (!isWindowsBackgroundFeatureReleaseEnabled() || preference !== false) return true;
  const mxc = getWindowsSandboxSubstrate()?.mxc;
  return (mxc !== undefined && mxc.state !== "unavailable") || isOfflineProcessConfinementActive();
}
