// Run `operation` the way the routine wiring runs a connected schedule's turn: inside a policy context that withholds the
// chat's session-bound authority.
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";

export function inScheduledWake<T>(operation: () => T): T {
  return turnExtensionPolicyContext.run(Object.freeze({ allowExternalHooks: true, withholdSessionAuthority: true }), operation);
}
