import {
  getWindowsAccountConfinementHelperIdentity,
  getWindowsConfinementRoute,
  isOfflineProcessConfinementActive,
} from "../../permissions/asrt-sandbox.js";
import { getMxcReleaseGateGeneration } from "../../permissions/mxc-extension-admission.js";
import { getWindowsExtensionBackendPlan } from "../../permissions/sandbox-capability.js";
import {
  isWindowsBackgroundFeatureReleaseEnabled,
  refreshWindowsBackgroundAdmission,
  type WindowsBackgroundAdmission,
} from "../../permissions/windows-background-features.js";
import { getWindowsContainerBackendLossEpoch } from "../../permissions/windows-confinement-evidence.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../../shared/ave-home.js";
import { DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX } from "../../shared/memory-embedding-config.js";
import { MemoryMapHostError } from "./errors.js";

export type LocalInferenceRoute = "offline-sandbox" | "mxc" | "unconfined";

export { refreshWindowsBackgroundAdmission as refreshLocalInferenceAdmission };

/** Select the currently permitted route using the caller's exact admission. */
export function assertLocalEmbeddingRuntime(preference = DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX,
  admission: WindowsBackgroundAdmission): LocalInferenceRoute {
  const plan = process.platform === "win32" ? getWindowsExtensionBackendPlan() : undefined;
  if (isWindowsBackgroundFeatureReleaseEnabled() && plan?.selectedBackend === "mxc" && plan.readiness === "ready" && isAveHomePrivacyVerifiedAtBoot()) return "mxc";
  const planRefuses = plan !== undefined && (plan.readiness === "checking" || plan.readiness === "rejected" || plan.selectedBackend === "mxc");
  if (!planRefuses && isOfflineProcessConfinementActive()) return "offline-sandbox";

  if (admission.areSwitchesAvailable()) {
    if (!preference) throw new MemoryMapHostError("local-inference-disabled");
    return "unconfined";
  }
  throw new MemoryMapHostError("local-runtime-unavailable");
}

export function bindLocalEmbeddingRuntime(readRoute: () => LocalInferenceRoute) {
  const route = readRoute();
  const readIdentity = (): readonly unknown[] => {
    if (route === "mxc") return [getWindowsExtensionBackendPlan(), getMxcReleaseGateGeneration(), getWindowsContainerBackendLossEpoch()];
    if (route === "offline-sandbox" && process.platform === "win32") {
      return [...getWindowsConfinementRoute(), getWindowsAccountConfinementHelperIdentity()];
    }
    return [];
  };
  const identity = readIdentity();
  const assertStillValid = () => {
    if (readRoute() !== route) throw new MemoryMapHostError("local-runtime-unavailable");
    const current = readIdentity();
    if (current.length !== identity.length || !identity.every((value, index) => Object.is(value, current[index]))) {
      throw new MemoryMapHostError("local-runtime-unavailable");
    }
  };
  return { route, assertStillValid };
}
