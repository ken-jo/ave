import { isOfflineProcessConfinementActive } from "../../permissions/asrt-sandbox.js";
import { hasMxcReleaseGateEvidence } from "../../permissions/mxc-extension-admission.js";
import { getWindowsExtensionBackendPlan, getWindowsSandboxSubstrate } from "../../permissions/sandbox-capability.js";
import { isAveHomePrivacyVerifiedAtBoot } from "../../shared/ave-home.js";
import { DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX } from "../../shared/memory-embedding-config.js";
import { MemoryMapHostError } from "./errors.js";

export type LocalInferenceRoute = "offline-sandbox" | "mxc" | "unconfined";

export function isLocalInferenceSwitchAvailable(): boolean {
  return process.platform === "win32" && hasMxcReleaseGateEvidence();
}

export function assertLocalEmbeddingRuntime(preference = DEFAULT_LOCAL_INFERENCE_WITHOUT_SANDBOX): LocalInferenceRoute {
  const plan = process.platform === "win32" ? getWindowsExtensionBackendPlan() : undefined;
  const switchAvailable = isLocalInferenceSwitchAvailable();
  if (switchAvailable && plan?.selectedBackend === "mxc" && plan.readiness === "ready" && isAveHomePrivacyVerifiedAtBoot()) return "mxc";
  const planRefuses = plan !== undefined && (plan.readiness === "checking" || plan.readiness === "rejected" || plan.selectedBackend === "mxc");
  if (!planRefuses && isOfflineProcessConfinementActive()) return "offline-sandbox";

  if (switchAvailable && plan?.selectedBackend === "none" && isAveHomePrivacyVerifiedAtBoot()) {
    const substrate = getWindowsSandboxSubstrate();
    if (substrate?.srtWinReady === false && substrate.mxc.state === "unavailable") {
      const reason = substrate.mxc.reason;
      const confirmedAbsent = reason === "unsupported-arch" || reason === "binary-missing" || reason === "container-unavailable";
      const planSettled = plan.readiness === "off" || (plan.readiness === "unavailable" && plan.reason === reason);
      if (confirmedAbsent && planSettled) {
        if (!preference) throw new MemoryMapHostError("local-inference-disabled");
        return "unconfined";
      }
    }
  }
  throw new MemoryMapHostError("local-runtime-unavailable");
}
