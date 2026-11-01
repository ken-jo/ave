import { randomUUID } from "node:crypto";
import type { PermissionCheckResult, PermissionManager } from "../permissions/permission-manager.js";
import { isHostApprovalRejectedDecision, type ApprovalDecision, type ApprovalGate } from "../permissions/approval-gate.js";
import { isRemoteControllerBoundToSession, remoteControllerOriginOf } from "../shared/chat-origin.js";
import { getHostShellExecutionPlan } from "../permissions/sandbox-capability.js";
import { getHostShellExecutionPlanAuditProjection, type HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit, consumeHostShellExecutionPermit, recordHostShellPolicyAuthorization } from "../permissions/host-shell-execution-permit.js";
import { captureShellWorkingDirectoryIdentity, matchesShellWorkingDirectoryIdentity } from "../permissions/shell-working-directory-identity.js";
import { buildPermissionEvaluationContext } from "../permissions/evaluation-context.js";
import { NO_APPROVER_MESSAGE } from "../permissions/decision-pipeline.js";
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

// Enrollment supplies executable identity; the shared pipeline supplies authority.
export function createHookCommandAuthorizer(deps: {
  permissionManager: Pick<PermissionManager, "ensureProjectRulesLoaded" | "checkDetailed" | "dispatchReviewer" | "resolveReviewedPermission" | "getPolicyEpoch" | "getMode">;
  approvalGate: Pick<ApprovalGate, "requestAndWait">;
}): HookCommandAuthorizer {
  return async (hook, payload, cwd) => {
    const command = hook.command.map(expandLeadingTilde).map(shellQuote).join(" ");
    const turnPolicy = turnExtensionPolicyContext.getStore();
    const abortSignal = turnPolicy?.abortSignal;
    const remoteControllerAuthority = turnPolicy?.remoteControllerAuthority;
    const controllerCurrent = () => isRemoteControllerBoundToSession(remoteControllerAuthority, payload.sessionId);
    if (!controllerCurrent()) return { decision: "deny", reason: "Remote controller authority was revoked or is not bound to this session" };
    if (abortSignal?.aborted) return { decision: "deny", reason: "Hook command was cancelled" };
    if (turnPolicy?.allowExternalHooks === false) return { decision: "deny", reason: "External hooks are disabled for this turn" };
    const cwdIdentity = captureShellWorkingDirectoryIdentity(cwd);
    if (!cwdIdentity) return { decision: "deny", reason: "Hook working directory is unavailable" };
    const plan = getHostShellExecutionPlan();
    await deps.permissionManager.ensureProjectRulesLoaded(cwd);
    const context = {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd },
      projectRulesCwd: cwd,
      sessionId: payload.sessionId,
      headless: turnPolicy?.headless,
      ownerUnattended: turnPolicy?.ownerUnattended,
      approvalSurface: turnPolicy?.approvalSurface,
      remoteControllerAuthority: turnPolicy?.remoteControllerAuthority,
      floor: turnPolicy?.floor,
      ...(plan.mode === "blocked" ? { admissionDenial: { code: "shell-execution-unavailable", reason: "Host shell execution is blocked" } } : {}),
      hostShellExecutionPlan: plan,
      shellExecution: { runsSandboxed: plan.sandboxed },
    } as const;
    const check = () => deps.permissionManager.checkDetailed("bash", "builtin", "shell", turnPolicy?.overlayTriggerOrigin, context);
    let result = check();
    if (result.decision === "deny") return { decision: "deny", reason: result.reason };
    const effectIdentity = (permission: PermissionCheckResult): string => JSON.stringify({
      paths: permission.pipelineRequest?.paths, floor: permission.pipelineRequest?.floor,
      secretRead: permission.pipelineRequest?.secretRead, shell: permission.pipelineRequest?.shell,
    });
    const requestedEffect = effectIdentity(result);
    const id = randomUUID();
    const args = { command, cwd, timeoutSeconds: Math.ceil((hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS) / 1000),
      ...(hook.env ? { env: { ...hook.env } } : {}) };
    const trustOrigin = payload.trustOrigin === "unknown" ? "llm-tool-arg" : payload.trustOrigin;
    const evaluationContext = buildPermissionEvaluationContext({
      policyMode: result.pipelineRequest?.mode ?? deps.permissionManager.getMode(),
      headless: result.pipelineRequest?.headless === true,
      source: "builtin", category: "shell", trustOrigin, executionCwd: cwd,
      allowedDirectories: [cwd], pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
    });
    if (result.reviewer) {
      const review = await deps.permissionManager.dispatchReviewer("bash", {
        invocationId: id, sessionId: payload.sessionId, source: "builtin", category: "shell", pathFields: [],
        finalInput: args, executionCwd: cwd, allowedDirectories: [cwd], sensitivePathsAdjacent: [],
        trustOrigin, permissionDecision: result, evaluationContext, hostShellExecutionPlan: plan,
      }, { hookId: hook.id, event: payload.hookType }, { lane: result.reviewer.route, abortSignal });
      result = deps.permissionManager.resolveReviewedPermission(result, review);
    }
    if (abortSignal?.aborted) return { decision: "deny", reason: "Hook command was cancelled" };
    if (result.decision === "deny") return { decision: "deny", reason: result.reason };
    const binding = plan.requiresExplicitUserApproval ? buildHostShellExecutionPermitBinding({
      plan, toolName: "bash", toolUseId: id, rawInput: args, executionCwd: cwd, extraAllowedDirectories: [],
    }) : undefined;
    if (plan.requiresExplicitUserApproval && !binding) return { decision: "deny", reason: "Hook host execution binding is invalid" };
    let approval: ApprovalDecision | undefined;
    const humanApproved = result.decision === "ask";
    if (humanApproved) {
      approval = await deps.approvalGate.requestAndWait({
        id, category: "tool", toolName: "bash", toolCategory: "shell",
        args: { ...args, hook: hook.id, event: payload.hookType }, reason: result.reason,
        source: "builtin", createdAt: Date.now(), sessionId: payload.sessionId, trustOrigin: payload.trustOrigin,
        evaluationContext, ownerUnattended: turnPolicy?.ownerUnattended, abortSignal,
        remoteControllerAuthority, remoteControllerOrigin: remoteControllerOriginOf(remoteControllerAuthority),
        reviewerVerdict: result.reviewer?.verdict, reviewerOutcome: result.reviewer?.outcome,
        reviewerApprovalBasis: result.reviewer?.approvalBasis,
        ...(result.forceModal ? { forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false } : {}),
        executionPlan: getHostShellExecutionPlanAuditProjection(plan),
        ...(binding ? { hostShellExecutionPermitBinding: binding } : {}),
      });
      if (abortSignal?.aborted) return { decision: "deny", reason: "Hook command was cancelled" };
      if (!controllerCurrent()) return { decision: "deny", reason: "Remote controller authority was revoked or is not bound to this session" };
      const rejected = Boolean(isHostApprovalRejectedDecision(approval));
      if (rejected || approval.choice !== "allow-once" && approval.choice !== "allow-session" && approval.choice !== "allow-always") {
        return { decision: "deny", reason: approval.rememberPattern === NO_APPROVER_MESSAGE ? NO_APPROVER_MESSAGE : "user denied hook command" };
      }
    }
    const current = check();
    if (current.decision === "deny") return { decision: "deny", reason: current.reason };
    if (effectIdentity(current) !== requestedEffect) return { decision: "deny", reason: "Hook command effect changed during approval" };
    if (!matchesShellWorkingDirectoryIdentity(cwd, cwdIdentity)) return { decision: "deny", reason: "Hook working directory changed during approval" };
    if (binding) {
      if (!humanApproved) recordHostShellPolicyAuthorization(binding);
      const permit = mintHostShellExecutionPermit({ plan, approvalDecision: approval, binding });
      if (!consumeHostShellExecutionPermit({ ...binding, permit })) {
        return { decision: "deny", reason: "Hook host execution approval receipt is invalid" };
      }
    }
    const policyEpoch = deps.permissionManager.getPolicyEpoch();
    const assertAllowed = (): void => {
      const current = check();
      if (!controllerCurrent() || abortSignal?.aborted || current.decision === "deny" || effectIdentity(current) !== requestedEffect || deps.permissionManager.getPolicyEpoch() !== policyEpoch || !matchesShellWorkingDirectoryIdentity(cwd, cwdIdentity)) {
        throw new Error(`Hook command permission changed: ${current.reason}`);
      }
    };
    return { decision: "allow", reason: humanApproved ? "user approved hook command" : result.reason, plan, assertAllowed };
  };
}
