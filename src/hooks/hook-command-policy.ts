import { randomUUID } from "node:crypto";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { getHostShellExecutionPlan } from "../permissions/sandbox-capability.js";
import { getHostShellExecutionPlanAuditProjection, type HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit, consumeHostShellExecutionPermit } from "../permissions/host-shell-execution-permit.js";
import { shellQuote } from "../lib/shell-resolver.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import type { RunnableHook } from "./script-hook-runner.js";
import type { ScriptHookStdin } from "./script-hook-types.js";
import { DEFAULT_HOOK_TIMEOUT_MS } from "./script-hook-types.js";
import { turnExtensionPolicyContext } from "../shared/turn-extension-policy.js";

export type HookCommandAuthorizer = (
  hook: RunnableHook,
  payload: ScriptHookStdin,
  cwd: string,
) => Promise<{ decision: "allow" | "deny"; reason: string; plan?: HostShellExecutionPlan; assertAllowed?: () => void }>;

/** Trusted user scripts still pass the host's shell rules and interactive approval. */
export function createHookCommandAuthorizer(deps: {
  permissionManager: Pick<PermissionManager, "ensureProjectRulesLoaded" | "checkDetailed">;
  approvalGate: Pick<ApprovalGate, "requestAndWait">;
}): HookCommandAuthorizer {
  return async (hook, payload, cwd) => {
    // This is a rules-language subject for a literal argv, never shell execution.
    const command = hook.command.map(expandLeadingTilde).map(shellQuote).join(" ");
    await deps.permissionManager.ensureProjectRulesLoaded(cwd);
    const context = {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd },
      projectRulesCwd: cwd,
      headless: turnExtensionPolicyContext.getStore()?.headless === true,
    } as const;
    const check = () => deps.permissionManager.checkDetailed("bash", "builtin", "shell", undefined, context);
    const assertAllowed = (approved: boolean) => (): void => {
      const current = check();
      if (current.decision === "deny" || (!approved && current.decision !== "allow")) {
        throw new Error(`Hook command permission changed: ${current.reason}`);
      }
    };
    const result = check();
    if (result.decision === "deny") return { decision: "deny", reason: result.reason };
    const plan = getHostShellExecutionPlan();
    if (plan.mode === "blocked") return { decision: "deny", reason: "Host shell execution is blocked" };
    if (result.decision === "allow" && !plan.requiresExplicitUserApproval) {
      return { decision: "allow", reason: result.reason, plan, assertAllowed: assertAllowed(false) };
    }
    const id = randomUUID();
    const args = { command, cwd, timeoutSeconds: Math.ceil((hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS) / 1000) };
    const binding = plan.requiresExplicitUserApproval ? buildHostShellExecutionPermitBinding({
      plan, toolName: "bash", toolUseId: id, rawInput: args, executionCwd: cwd, extraAllowedDirectories: [],
    }) : undefined;
    if (plan.requiresExplicitUserApproval && !binding) return { decision: "deny", reason: "Hook host execution binding is invalid" };
    const approval = await deps.approvalGate.requestAndWait({
      id,
      category: "tool",
      toolName: "bash",
      toolCategory: "shell",
      args: { ...args, hook: hook.id, event: payload.hookType },
      reason: plan.requiresExplicitUserApproval ? "User hook requires explicit host execution approval" : result.reason,
      source: "builtin",
      createdAt: Date.now(),
      sessionId: payload.sessionId,
      trustOrigin: payload.trustOrigin,
      forceExplicit: true,
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      executionPlan: getHostShellExecutionPlanAuditProjection(plan),
      ...(binding ? { hostShellExecutionPermitBinding: binding } : {}),
    });
    if (approval.choice !== "allow-once") return { decision: "deny", reason: "user denied hook command" };
    const current = check();
    if (current.decision === "deny") return { decision: "deny", reason: current.reason };
    if (binding) {
      const permit = mintHostShellExecutionPermit({ plan, approvalDecision: approval, binding });
      if (!consumeHostShellExecutionPermit({ ...binding, permit })) {
        return { decision: "deny", reason: "Hook host execution approval receipt is invalid" };
      }
    }
    return { decision: "allow", reason: "user approved hook command", plan, assertAllowed: assertAllowed(true) };
  };
}
