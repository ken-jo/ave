import type { SessionSearchIndexPolicy, SessionSearchIndexPolicySource } from "../memory/session-search-index.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../shared/ave-home.js";
import { isWindowsBackgroundConfinementRuntimeActive } from "./asrt-sandbox.js";
import { getMxcReleaseGateGeneration, hasMxcReleaseGateEvidence } from "./mxc-extension-admission.js";
import { mxcSandboxHomesParent } from "./mxc-runtime-root.js";
import {
  getSandboxHomesUnavailable,
  getWindowsExtensionBackendPlan,
  getWindowsSandboxSubstrate,
  isSandboxGateUndecidedAtBoot,
  markSandboxHomesUnavailable,
} from "./sandbox-capability.js";
import {
  refreshWindowsBackendEvidence,
  WINDOWS_BACKEND_EVIDENCE,
  type WindowsBackendEvidenceOwner,
  type WindowsBackendState,
} from "./windows-confinement-evidence.js";

export function isWindowsBackgroundFeatureReleaseEnabled(): boolean {
  return process.platform === "win32" && hasMxcReleaseGateEvidence();
}

/** A synchronous, fail-closed decision over one set of backend evidence and the current HOME proof. */
export interface WindowsBackgroundAdmission {
  readonly areSwitchesAvailable: () => boolean;
  readonly searchIndexPolicy: (preference: boolean | undefined) => SessionSearchIndexPolicy;
}

const INACTIVE_ADMISSION: WindowsBackgroundAdmission = {
  areSwitchesAvailable: () => false,
  searchIndexPolicy: () => "inactive",
};

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

function admissionOver(stateOf: (owner: WindowsBackendEvidenceOwner) => WindowsBackendState | undefined): WindowsBackgroundAdmission {
  // Absence needs the boot record and the current evidence of every backend to agree.
  const hasDefinitiveBackendAbsence = (): boolean => {
    const substrate = getWindowsSandboxSubstrate();
    const plan = getWindowsExtensionBackendPlan();
    if (plan?.selectedBackend !== "none" || substrate?.shells !== "none"
      || !WINDOWS_BACKEND_EVIDENCE.every((owner) => owner.provider.isAbsentAtBoot(substrate) && stateOf(owner) === "absent")) return false;
    return plan.readiness === "off" || (plan.readiness === "unavailable"
      && (plan.reason === (substrate.mxc.state === "unavailable" ? substrate.mxc.reason : undefined) || plan.reason === "native-validation-required"));
  };
  return {
    areSwitchesAvailable: () => isWindowsBackgroundFeatureReleaseEnabled() && !isSandboxGateUndecidedAtBoot() && !isWindowsBackgroundConfinementRuntimeActive()
      && hasDefinitiveBackendAbsence() && hasWindowsBackgroundHealth(),
    searchIndexPolicy: (preference) => {
      if (isSandboxGateUndecidedAtBoot()) return "inactive";
      const substrate = getWindowsSandboxSubstrate();
      const confinementOperational = substrate !== null && isWindowsBackgroundConfinementRuntimeActive() && WINDOWS_BACKEND_EVIDENCE
        .some((owner) => owner.provider.isRoutePublished(substrate) && stateOf(owner) === "operational");
      if (!confinementOperational && (isWindowsBackgroundConfinementRuntimeActive() || !hasDefinitiveBackendAbsence())) return "inactive";
      if (!hasWindowsBackgroundHealth()) return "inactive";
      return !confinementOperational && preference === false ? "paused" : "enabled-with-recovery";
    },
  };
}

/**
 * Probes every backend for the calling operation, off the event loop. The returned admission holds only while each
 * owner still carries the evidence this refresh produced, so the caller decides synchronously, with no await before the
 * action. A caller that asks about the switches alone gets its refusal without a probe once any backend is on record.
 */
export async function refreshWindowsBackgroundAdmission(scope: "all" | "switches" = "all"): Promise<WindowsBackgroundAdmission> {
  const releaseGeneration = getMxcReleaseGateGeneration();
  const releaseIsCurrent = () => releaseGeneration === getMxcReleaseGateGeneration();
  if (!isWindowsBackgroundFeatureReleaseEnabled()) {
    return {
      areSwitchesAvailable: INACTIVE_ADMISSION.areSwitchesAvailable,
      searchIndexPolicy: () => releaseIsCurrent() ? "enabled" : "inactive",
    };
  }
  if (isSandboxGateUndecidedAtBoot()) return INACTIVE_ADMISSION;
  const substrate = getWindowsSandboxSubstrate();
  if (scope === "switches" && !(substrate !== null && WINDOWS_BACKEND_EVIDENCE.every((owner) => owner.provider.isAbsentAtBoot(substrate)))) {
    return INACTIVE_ADMISSION;
  }
  const refreshed = await refreshWindowsBackendEvidence();
  const receiptsAreCurrent = () => releaseIsCurrent() && WINDOWS_BACKEND_EVIDENCE.every((owner) => {
    const receipt = refreshed.get(owner);
    return receipt !== undefined && owner.isCurrent(receipt);
  });
  const admission = admissionOver((owner) => refreshed.get(owner)?.state);
  return {
    areSwitchesAvailable: () => receiptsAreCurrent() && admission.areSwitchesAvailable(),
    searchIndexPolicy: (preference) => receiptsAreCurrent() ? admission.searchIndexPolicy(preference) : "inactive",
  };
}

/** The session stores take a refreshed admission for each claimed batch of database work. */
export function sessionSearchIndexPolicySource(getPreference: () => boolean | undefined): Required<Pick<SessionSearchIndexPolicySource, "refreshSearchIndexPolicy">> {
  return {
    refreshSearchIndexPolicy: async () => {
      const admission = await refreshWindowsBackgroundAdmission();
      return () => admission.searchIndexPolicy(getPreference());
    },
  };
}
