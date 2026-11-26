import type { SessionSearchIndexPolicy } from "../memory/session-search-index.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../shared/ave-home.js";
import { isAsrtSandboxActive, isOfflineProcessConfinementActive } from "./asrt-sandbox.js";
import { hasMxcReleaseGateEvidence } from "./mxc-extension-admission.js";
import { mxcSandboxHomesParent } from "./mxc-runtime-root.js";
import {
  detectMxcShellCapability,
  getSandboxHomesUnavailable,
  getWindowsExtensionBackendPlan,
  getWindowsSandboxSubstrate,
  isSandboxGateUndecidedAtBoot,
  markSandboxHomesUnavailable,
} from "./sandbox-capability.js";

export function isWindowsBackgroundFeatureReleaseEnabled(): boolean {
  return process.platform === "win32" && hasMxcReleaseGateEvidence();
}

function hasWindowsBackgroundHealth(): boolean {
  return !isSandboxGateUndecidedAtBoot() && isAveHomePrivacyVerifiedAtBoot() && !getSandboxHomesUnavailable();
}

function hasDefinitiveWindowsBackendAbsence(): boolean {
  const substrate = getWindowsSandboxSubstrate();
  const plan = getWindowsExtensionBackendPlan();
  if (plan?.selectedBackend !== "none" || substrate?.shells !== "none"
    || substrate.accountBackendAbsent !== true || substrate.srtWinReady !== false
    || substrate.mxc.state !== "unavailable" || substrate.mxc.reason !== "container-unavailable"
    || substrate.mxc.containerBackendAbsent !== true) return false;
  return plan.readiness === "off" || (plan.readiness === "unavailable"
    && (plan.reason === substrate.mxc.reason || plan.reason === "native-validation-required"));
}

export function areWindowsBackgroundSwitchesAvailable(): boolean {
  return isWindowsBackgroundFeatureReleaseEnabled() && hasWindowsBackgroundHealth()
    && !isOfflineProcessConfinementActive() && hasDefinitiveWindowsBackendAbsence();
}

export function sessionSearchIndexPolicy(preference: boolean | undefined): SessionSearchIndexPolicy {
  if (!isWindowsBackgroundFeatureReleaseEnabled()) return "enabled";
  if (!hasWindowsBackgroundHealth()) return "inactive";
  const substrate = getWindowsSandboxSubstrate();
  const confinementOperational = isOfflineProcessConfinementActive()
    || (substrate?.mxc.state === "available" && isAsrtSandboxActive()
      && detectMxcShellCapability()?.confidence === "verified");
  if (!confinementOperational && !hasDefinitiveWindowsBackendAbsence()) return "inactive";
  try {
    // Recheck the root and HOME parent even before a failed child start can report their loss.
    mxcSandboxHomesParent();
  } catch {
    markSandboxHomesUnavailable();
    return "inactive";
  }
  return !confinementOperational && preference === false ? "paused" : "enabled-with-recovery";
}
