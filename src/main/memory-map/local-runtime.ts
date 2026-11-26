import { isOfflineProcessConfinementActive } from "../../permissions/asrt-sandbox.js";
import { getWindowsExtensionBackendPlan } from "../../permissions/sandbox-capability.js";
import {
  isWindowsBackgroundFeatureReleaseEnabled,
  refreshWindowsBackgroundAdmission,
  settledWindowsBackgroundAdmission,
  type WindowsBackgroundAdmission,
} from "../../permissions/windows-background-features.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../../shared/ave-home.js";
import { DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX } from "../../shared/memory-embedding-config.js";
import { MemoryMapHostError } from "./errors.js";

export type LocalInferenceRoute = "offline-sandbox" | "mxc" | "unconfined";

export { refreshWindowsBackgroundAdmission as refreshLocalInferenceAdmission };

/** Status reads may rest on settled evidence; a host child starts only on an admission refreshed for that start. */
export function assertLocalEmbeddingRuntime(preference = DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX,
  admission: WindowsBackgroundAdmission = settledWindowsBackgroundAdmission): LocalInferenceRoute {
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
