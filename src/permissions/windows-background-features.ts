import type { SessionSearchIndexPolicy } from "../memory/session-search-index.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../shared/ave-home.js";
import { isAsrtSandboxActive, isWindowsAccountConfinementOperational } from "./asrt-sandbox.js";
import { hasMxcReleaseGateEvidence } from "./mxc-extension-admission.js";
import { mxcSandboxHomesParent } from "./mxc-runtime-root.js";
import { requireHostWxcExecFile } from "./mxc-windows.js";
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
  if (!isAveHomePrivacyVerifiedAtBoot() || getSandboxHomesUnavailable()) return false;
  try {
    mxcSandboxHomesParent();
    return true;
  } catch {
    markSandboxHomesUnavailable();
    return false;
  }
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
  return isWindowsBackgroundFeatureReleaseEnabled() && !isSandboxGateUndecidedAtBoot() && !isAsrtSandboxActive()
    && hasDefinitiveWindowsBackendAbsence() && hasWindowsBackgroundHealth();
}

function isWindowsContainerConfinementOperational(): boolean {
  if (!isAsrtSandboxActive() || detectMxcShellCapability()?.confidence !== "verified") return false;
  try {
    requireHostWxcExecFile();
    return true;
  } catch {
    return false;
  }
}

export function sessionSearchIndexPolicy(preference: boolean | undefined): SessionSearchIndexPolicy {
  if (!isWindowsBackgroundFeatureReleaseEnabled()) return "enabled";
  if (isSandboxGateUndecidedAtBoot()) return "inactive";
  const substrate = getWindowsSandboxSubstrate();
  const confinementOperational = (substrate?.srtWinReady === true && substrate.accountBackendAbsent !== true
      && isWindowsAccountConfinementOperational())
    || (substrate?.mxc.state === "available" && substrate.shells === "mxc" && isWindowsContainerConfinementOperational());
  if (!confinementOperational && (isAsrtSandboxActive() || !hasDefinitiveWindowsBackendAbsence())) return "inactive";
  if (!hasWindowsBackgroundHealth()) return "inactive";
  return !confinementOperational && preference === false ? "paused" : "enabled-with-recovery";
}
