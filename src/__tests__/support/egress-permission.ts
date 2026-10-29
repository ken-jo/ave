import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createShellNetworkPermissionEvaluator } from "../../permissions/egress-approval.js";
import { createEgressAskCallback as createCallback, type EgressAskDeps as CallbackDeps } from "../../permissions/egress-ask.js";

export type EgressAskDeps = Omit<CallbackDeps, "evaluateShellPermission"> & {
  networkRule: PermissionManager["networkRuleDecision"];
  evaluateShellPermission?: CallbackDeps["evaluateShellPermission"];
};

/** Keep network mechanics fixtures on the real manager and normalized policy evaluator. */
export function createEgressAskCallback(deps: EgressAskDeps) {
  const { networkRule, evaluateShellPermission, ...callbacks } = deps;
  const manager = new PermissionManager(join(tmpdir(), `egress-mechanics-${randomUUID()}.json`));
  manager.setMode("strict");
  vi.spyOn(manager, "networkRuleDecision").mockImplementation(networkRule);
  return createCallback({ ...callbacks, evaluateShellPermission: evaluateShellPermission ?? createShellNetworkPermissionEvaluator(manager) });
}
