import type { SessionSearchIndexPolicy, SessionSearchIndexPolicySource } from "../memory/session-search-index.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../shared/ave-home.js";
import { isAsrtSandboxActive } from "./asrt-sandbox.js";
import { hasMxcReleaseGateEvidence } from "./mxc-extension-admission.js";
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
    areSwitchesAvailable: () => isWindowsBackgroundFeatureReleaseEnabled() && !isSandboxGateUndecidedAtBoot() && !isAsrtSandboxActive()
      && hasDefinitiveBackendAbsence() && hasWindowsBackgroundHealth(),
    searchIndexPolicy: (preference) => {
      if (!isWindowsBackgroundFeatureReleaseEnabled()) return "enabled";
      if (isSandboxGateUndecidedAtBoot()) return "inactive";
      const substrate = getWindowsSandboxSubstrate();
      const confinementOperational = substrate !== null && isAsrtSandboxActive() && WINDOWS_BACKEND_EVIDENCE
        .some((owner) => owner.provider.isRoutePublished(substrate) && stateOf(owner) === "operational");
      if (!confinementOperational && (isAsrtSandboxActive() || !hasDefinitiveBackendAbsence())) return "inactive";
      if (!hasWindowsBackgroundHealth()) return "inactive";
      return !confinementOperational && preference === false ? "paused" : "enabled-with-recovery";
    },
  };
}

/**
 * The last settled evidence, read without probing. It answers status and deferral questions only:
 * database work, the switches and unconfined inference take an admission from `refreshWindowsBackgroundAdmission`.
 */
export const settledWindowsBackgroundAdmission: WindowsBackgroundAdmission = admissionOver((owner) => owner.current()?.state);

/**
 * Probes every backend for the calling operation, off the event loop. The returned admission holds only while each
 * owner still carries the evidence this refresh produced, so the caller decides synchronously, with no await before the
 * action. A caller that asks about the switches alone gets its refusal without a probe once any backend is on record.
 */
export async function refreshWindowsBackgroundAdmission(scope: "all" | "switches" = "all"): Promise<WindowsBackgroundAdmission> {
  if (!isWindowsBackgroundFeatureReleaseEnabled() || isSandboxGateUndecidedAtBoot()) return settledWindowsBackgroundAdmission;
  const substrate = getWindowsSandboxSubstrate();
  if (scope === "switches" && !(substrate !== null && WINDOWS_BACKEND_EVIDENCE.every((owner) => owner.provider.isAbsentAtBoot(substrate)))) {
    return admissionOver(() => undefined);
  }
  const refreshed = await refreshWindowsBackendEvidence();
  return admissionOver((owner) => {
    const evidence = refreshed.get(owner);
    return evidence !== undefined && owner.current() === evidence ? evidence.state : undefined;
  });
}

/** The session stores' policy: the settled read for repair deferral, a refreshed admission for each database operation. */
export function sessionSearchIndexPolicySource(getPreference: () => boolean | undefined): Required<SessionSearchIndexPolicySource> {
  return {
    getSearchIndexPolicy: () => settledWindowsBackgroundAdmission.searchIndexPolicy(getPreference()),
    refreshSearchIndexPolicy: async () => {
      const admission = await refreshWindowsBackgroundAdmission();
      return () => admission.searchIndexPolicy(getPreference());
    },
  };
}
