import { isOfflineProcessConfinementActive } from "../../permissions/asrt-sandbox.js";
import { getWindowsExtensionBackendPlan } from "../../permissions/sandbox-capability.js";
import { MemoryMapHostError } from "./errors.js";

// Local inference runs only in a child the OS sandbox keeps off the network, on every platform; without that sandbox it is unavailable.
export function assertLocalEmbeddingRuntime(): void {
  const plan = process.platform === "win32" ? getWindowsExtensionBackendPlan() : undefined;
  const planRefuses = plan !== undefined && (plan.readiness === "checking" || plan.readiness === "rejected" || plan.selectedBackend === "mxc");
  if (!isOfflineProcessConfinementActive() || planRefuses) throw new MemoryMapHostError("local-runtime-unavailable");
}
