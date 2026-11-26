import { isOfflineProcessConfinementActive } from "../../permissions/asrt-sandbox.js";
import { getWindowsExtensionBackendPlan } from "../../permissions/sandbox-capability.js";
import { areWindowsBackgroundSwitchesAvailable, isWindowsBackgroundFeatureReleaseEnabled } from "../../permissions/windows-background-features.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../../shared/ave-home.js";
import { DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX } from "../../shared/memory-embedding-config.js";
import { MemoryMapHostError } from "./errors.js";

export type LocalInferenceRoute = "offline-sandbox" | "mxc" | "unconfined";

export { areWindowsBackgroundSwitchesAvailable as isLocalInferenceSwitchAvailable };

export function assertLocalEmbeddingRuntime(preference = DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX): LocalInferenceRoute {
  const plan = process.platform === "win32" ? getWindowsExtensionBackendPlan() : undefined;
  if (isWindowsBackgroundFeatureReleaseEnabled() && plan?.selectedBackend === "mxc" && plan.readiness === "ready" && isAveHomePrivacyVerifiedAtBoot()) return "mxc";
  const planRefuses = plan !== undefined && (plan.readiness === "checking" || plan.readiness === "rejected" || plan.selectedBackend === "mxc");
  if (!planRefuses && isOfflineProcessConfinementActive()) return "offline-sandbox";

  if (areWindowsBackgroundSwitchesAvailable()) {
    if (!preference) throw new MemoryMapHostError("local-inference-disabled");
    return "unconfined";
  }
  throw new MemoryMapHostError("local-runtime-unavailable");
}
