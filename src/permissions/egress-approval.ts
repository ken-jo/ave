// Egress scopes must be among those offered by the gate; terminal asks stay in the owning window/tab. Grants belong to the egress store, never user-decision memory.
import { type AnswerEpochs, personAnswerStands } from "./pending-answer-policy.js";
import type { NetworkPermissionEvaluation, NetworkRuleScope, PermissionManager } from "./permission-manager.js";
import type { EgressGrantScope } from "../shared/egress-grant-scopes.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { NO_APPROVER_MESSAGE } from "./decision-pipeline.js";
import { remoteControllerOriginOf } from "../shared/chat-origin.js";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { canonicalRuleSpecifier } from "./rules/rule-specifier.js";
import {
  isHostApprovalRejectedDecision,
  isHostApprovalTimeoutDecision,
  type ApprovalGate,
} from "./approval-gate.js";
import type { EgressApprovalAnswer, EgressApprovalRequester, ShellNetworkPermissionEvaluator } from "./egress-ask.js";

// The exact host rule for one destination, or null for an address literal, which the host grammar does not name. A canonical host name that does not parse is a contract violation and throws.
function exactNetworkRule(host: string, port: number): string | null {
  if (isIP(host) !== 0) return null;
  return canonicalRuleSpecifier(`Network(${host}:${port})`);
}

// The tool name a terminal tab's egress ask carries on the gate (its audit rows and card).
const TERMINAL_EGRESS_TOOL_NAME = "terminal";

export const EGRESS_APPROVAL_DENY_REASONS = {
  denied: "denied by the user",
  timeout: "network approval timed out",
  rejected: "network approval answer was rejected",
} as const;

export function createShellNetworkPermissionEvaluator(manager?: PermissionManager): ShellNetworkPermissionEvaluator {
  return async (request) => {
    if (!manager) throw new Error("Shell egress requires a permission manager");
    const cwd = request.context.workspaceRoot ?? process.cwd();
    await manager.ensureProjectRulesLoaded(cwd);
    const ruleScopes: NetworkRuleScope[] = [];
    if (request.scopes.includes("always")) ruleScopes.push("user");
    if (request.scopes.includes("project")) ruleScopes.push("project");
    if (request.scopes.includes("session")) ruleScopes.push("session");
    const destination = { ...request.destination, source: "builtin" as const, network: request.network, ruleScopes };
    const context = {
      ...request.context.permissionContext,
      headless: request.context.headless === true || request.context.approvalSurface === "unavailable",
      approvalSurface: request.context.approvalSurface,
      ownerUnattended: request.context.ownerUnattended ?? request.context.permissionContext?.ownerUnattended,
      projectRulesCwd: cwd, sessionId: request.context.sessionId,
    };
    const snapshot = (evaluated: NetworkPermissionEvaluation, rememberedGrant: EgressGrantScope | undefined) => {
      const permission = rememberedGrant === undefined ? evaluated.permission
        : manager.resolveRememberedPermission(evaluated.permission, "An existing destination grant covers this exact connection.");
      if (!permission.pipelineRequest) throw new Error("Network permission request has no normalized evidence");
      const { reviewer: _reviewer, ...identity } = permission.pipelineRequest;
      return { ...evaluated, permission, reasonKey: permission.reasonCode ?? evaluated.reasonKey,
        policyEpoch: manager.getPolicyEpoch(), policyContextEpoch: manager.getPolicyContextEpoch(), approvalIdentity: canonicalStringify(identity) };
    };
    const evaluated = await manager.checkNetworkPermission(destination, context);
    return {
      ...snapshot(evaluated, request.rememberedGrant),
      recheck: (rememberedGrant, approvalSurface) => snapshot(manager.checkLoadedNetworkPermission(destination, {
        ...context, approvalSurface, headless: request.context.headless === true || approvalSurface === "unavailable",
      }), rememberedGrant),
    };
  };
}

export function createApprovalGateEgressRequester(
  gate: Pick<ApprovalGate, "requestAndWait">,
  permissionManager?: PermissionManager,
): EgressApprovalRequester {
  const evaluateShellPermission = createShellNetworkPermissionEvaluator(permissionManager);
  return async (request): Promise<EgressApprovalAnswer> => {
    const requestId = randomUUID();
    const { host, port } = request.destination;
    const terminal = request.origin === "terminal";
    // A confined terminal retains its incarnation identity while delivery follows its registered conversation owner.
    const toolName = terminal ? TERMINAL_EGRESS_TOOL_NAME : request.toolName;
    let reviewerVerdict;
    let forced = false;
    // What the card is asked under, and the destination judged again by the policy as it is now (pending-answer-policy.ts).
    let opened: AnswerEpochs | undefined;
    let recheckDestination: (() => { decision: "allow" | "ask" | "deny"; forceModal?: boolean }) | undefined;
    if (request.origin === "shell") {
      if (!permissionManager) throw new Error("Shell egress requires a permission manager");
      const cwd = request.workspaceRoot ?? process.cwd();
      const headless = request.headless === true || request.approvalSurface === "unavailable";
      const evaluated = request.evaluation ?? await evaluateShellPermission({ destination: request.destination, network: request.network, scopes: request.scopes,
        context: { sessionId: request.sessionId, workspaceRoot: request.workspaceRoot, headless: request.headless,
          ownerUnattended: request.ownerUnattended, approvalSurface: request.approvalSurface ?? (headless ? "unavailable" : "interactive"),
          permissionContext: request.permissionContext, onNoApprover: request.onNoApprover } });
      if (evaluated.destination.host !== host || evaluated.destination.port !== port) throw new Error("Network permission destination changed");
      let permission = evaluated.permission;
      forced = permission.forceModal === true;
      opened = { epoch: evaluated.policyEpoch, contextEpoch: evaluated.policyContextEpoch };
      recheckDestination = () => evaluated.recheck(undefined, request.approvalSurface ?? (headless ? "unavailable" : "interactive")).permission;
      if (permission.reviewer && permission.decision === "ask" && !permission.forceModal) {
        const review = await permissionManager.dispatchReviewer("sandbox_network", {
          permissionDecision: permission,
          invocationId: requestId,
          source: "builtin", category: "network", pathFields: [],
          finalInput: { url: `https://${host.includes(":") ? `[${host}]` : host}:${port}/`, network: request.network },
          executionCwd: cwd, allowedDirectories: [cwd], sensitivePathsAdjacent: [],
          trustOrigin: "llm-tool-arg",
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        }, undefined, { lane: permission.reviewer.route, ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}) });
        permission = permissionManager.resolveReviewedPermission(permission, review);
        reviewerVerdict = review.verdict;
      }
      if (permission.decision === "allow" && request.scopes.includes("once")) return { allow: true, scope: "once", oneConnection: true };
      if (permission.decision === "deny") {
        if (permission.reasonCode === "no-approver") request.onNoApprover?.();
        return { allow: false, reason: permission.reason };
      }
      if (headless) { request.onNoApprover?.(); return { allow: false, reason: NO_APPROVER_MESSAGE }; }
    }
    const remoteControllerAuthority = terminal ? undefined : request.permissionContext?.remoteControllerAuthority;
    const decision = await gate.requestAndWait({
      id: requestId,
      category: "tool",
      kind: "egress-host",
      toolName,
      toolCategory: "network",
      ...(reviewerVerdict === undefined ? {} : { reviewerVerdict }),
      args: terminal ? { host, port, tabId: request.tabId } : { host, port },
      reason: (terminal
        ? `A command in an isolated conversation terminal wants to connect to ${host}:${port}.`
        : `The sandboxed ${request.toolName} command wants to connect to ${host}:${port}.`),
      createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"],
      // A grant is recorded by the egress grant store, never as a user-approval-store record, and the card must be answered by a person.
      durableApprovalRecordAllowed: false,
      forceExplicit: true,
      ...(!terminal ? { ownerUnattended: request.ownerUnattended, toolApprovalWait: request.toolApprovalWait } : {}),
      ...(remoteControllerAuthority === undefined ? {} : {
        remoteControllerAuthority,
        remoteControllerOrigin: remoteControllerOriginOf(remoteControllerAuthority),
        trustOrigin: remoteControllerAuthority.kind === "tailnet-controller" ? "tailnet-surface" : "platform-bridge",
      }),
      egressHost: {
        host,
        port,
        scopes: forced ? ["once"] : [...request.scopes],
        network: request.network,
        // Host rules are shell-origin; a terminal tab's connections are decided by its grants alone.
        rule: terminal ? null : exactNetworkRule(host, port),
        ...(terminal ? { terminalTabId: request.tabId } : {}),
        ...(!terminal && !forced && request.scopes.includes("project") && request.workspaceRoot !== undefined ? { projectCwd: request.workspaceRoot } : {}),
      },
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
    });
    if (!terminal && decision.rememberPattern === NO_APPROVER_MESSAGE) { request.onNoApprover?.(); return { allow: false, reason: NO_APPROVER_MESSAGE }; }
    if (decision.choice === "allow-once" && decision.egressScope !== undefined && request.scopes.includes(decision.egressScope)) {
      // Only an allow depends on the policy it was asked under. A deny stands, so the rule a "deny always" answer saves is not read as an outside change.
      // A sibling stage's "Allow for this run", or a run that ended, leaves the answer standing; every other change refuses it.
      if (!terminal && !(opened !== undefined && recheckDestination !== undefined && personAnswerStands(permissionManager!, opened, forced, recheckDestination))) {
        return { allow: false, reason: "Permission policy changed during network approval." };
      }
      if (forced && decision.egressScope !== "once") return { allow: false, reason: "A forced network approval is valid for one connection only." };
      return { allow: true, scope: decision.egressScope, ...(forced ? { oneConnection: true as const } : {}) };
    }
    const timedOut = Boolean(isHostApprovalTimeoutDecision(decision));
    const rejected = Boolean(isHostApprovalRejectedDecision(decision));
    return {
      allow: false,
      reason: timedOut
        ? EGRESS_APPROVAL_DENY_REASONS.timeout
        : rejected
          ? EGRESS_APPROVAL_DENY_REASONS.rejected
          : EGRESS_APPROVAL_DENY_REASONS.denied,
      ...(!timedOut && !rejected && decision.choice.startsWith("deny") ? { humanDenied: true as const } : {}),
    };
  };
}
