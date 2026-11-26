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
  getWindowsContainerBackendLossEpoch,
  refreshWindowsBackendEvidence,
  WINDOWS_BACKEND_EVIDENCE,
  type WindowsBackend,
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
  readonly isBackendOperational: (backend: WindowsBackend) => boolean;
}

const BACKEND_OWNERS = Object.values(WINDOWS_BACKEND_EVIDENCE);
const INACTIVE_ADMISSION: WindowsBackgroundAdmission = {
  areSwitchesAvailable: () => false,
  searchIndexPolicy: () => "inactive",
  isBackendOperational: () => false,
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

function admissionOver(stateOf: (owner: WindowsBackendEvidenceOwner) => WindowsBackendState | undefined): Omit<WindowsBackgroundAdmission, "isBackendOperational"> {
  // Absence needs the boot record and the current evidence of every backend to agree.
  const hasDefinitiveBackendAbsence = (): boolean => {
    const substrate = getWindowsSandboxSubstrate();
    const plan = getWindowsExtensionBackendPlan();
    if (plan?.selectedBackend !== "none" || substrate?.shells !== "none"
      || !BACKEND_OWNERS.every((owner) => owner.provider.isAbsentAtBoot(substrate) && stateOf(owner) === "absent")) return false;
    return plan.readiness === "off" || (plan.readiness === "unavailable"
      && (plan.reason === (substrate.mxc.state === "unavailable" ? substrate.mxc.reason : undefined) || plan.reason === "native-validation-required"));
  };
  return {
    areSwitchesAvailable: () => isWindowsBackgroundFeatureReleaseEnabled() && !isSandboxGateUndecidedAtBoot() && !isWindowsBackgroundConfinementRuntimeActive()
      && hasDefinitiveBackendAbsence() && hasWindowsBackgroundHealth(),
    searchIndexPolicy: (preference) => {
      if (isSandboxGateUndecidedAtBoot()) return "inactive";
      const substrate = getWindowsSandboxSubstrate();
      const confinementOperational = substrate !== null && isWindowsBackgroundConfinementRuntimeActive() && BACKEND_OWNERS
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
export async function refreshWindowsBackgroundAdmission(scope: "all" | "switches" | "extension" | WindowsBackend = "all"): Promise<WindowsBackgroundAdmission> {
  const releaseGeneration = getMxcReleaseGateGeneration();
  const releaseIsCurrent = () => releaseGeneration === getMxcReleaseGateGeneration();
  if (scope === "extension") {
    if (!isWindowsBackgroundFeatureReleaseEnabled() || isSandboxGateUndecidedAtBoot()) return INACTIVE_ADMISSION;
    const plan = getWindowsExtensionBackendPlan();
    const epoch = getWindowsContainerBackendLossEpoch();
    return {
      ...INACTIVE_ADMISSION,
      // The holder separately verifies its own native start. Shell startup evidence cannot admit or withdraw it.
      isBackendOperational: (backend) => backend === "container" && plan?.selectedBackend === "mxc" && plan.readiness === "ready"
        && releaseIsCurrent() && getWindowsExtensionBackendPlan() === plan && epoch === getWindowsContainerBackendLossEpoch()
        && hasWindowsBackgroundHealth(),
    };
  }
  if (scope !== "all" && scope !== "switches") {
    if (process.platform !== "win32" || isSandboxGateUndecidedAtBoot()) return INACTIVE_ADMISSION;
    const owner = WINDOWS_BACKEND_EVIDENCE[scope];
    const receipt = await owner.refresh();
    return {
      ...INACTIVE_ADMISSION,
      isBackendOperational: (backend) => backend === scope && releaseIsCurrent() && receipt?.state === "operational" && owner.isCurrent(receipt)
        && hasWindowsBackgroundHealth(),
    };
  }
  if (!isWindowsBackgroundFeatureReleaseEnabled()) {
    return {
      ...INACTIVE_ADMISSION,
      searchIndexPolicy: () => releaseIsCurrent() ? "enabled" : "inactive",
    };
  }
  if (isSandboxGateUndecidedAtBoot()) return INACTIVE_ADMISSION;
  const substrate = getWindowsSandboxSubstrate();
  if (scope === "switches" && !(substrate !== null && BACKEND_OWNERS.every((owner) => owner.provider.isAbsentAtBoot(substrate)))) {
    return INACTIVE_ADMISSION;
  }
  const refreshed = await refreshWindowsBackendEvidence();
  const currentState = (owner: WindowsBackendEvidenceOwner) => {
    const receipt = refreshed.get(owner);
    return receipt !== undefined && owner.isCurrent(receipt) ? receipt.state : undefined;
  };
  const receiptsAreCurrent = () => releaseIsCurrent() && BACKEND_OWNERS.every(owner => currentState(owner) !== undefined);
  const admission = admissionOver((owner) => refreshed.get(owner)?.state);
  return {
    areSwitchesAvailable: () => receiptsAreCurrent() && admission.areSwitchesAvailable(),
    searchIndexPolicy: (preference) => receiptsAreCurrent() ? admission.searchIndexPolicy(preference) : "inactive",
    isBackendOperational: backend => releaseIsCurrent() && currentState(WINDOWS_BACKEND_EVIDENCE[backend]) === "operational" && hasWindowsBackgroundHealth(),
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
