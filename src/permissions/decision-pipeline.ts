import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { UserOwnedSurface, UserOwnedSurfaceChoice } from "../shared/permissions-events.js";

export type PermissionPipelineOutcome = "allow" | "sandbox-auto" | "ask" | "ask-forced" | "deny";
export type PermissionFloorCode = "protected-path" | "critical-delete" | "project-escape" | "exfiltration" | "other-principal";

export interface PermissionDecisionRequest {
  tool: { name: string; source: ToolSource; kind: ToolCategory | "mcp" | "file-write"; readOnlyHint?: boolean };
  mode: "strict" | "default" | "auto" | "allow";
  headless: boolean;
  sessionId?: string;
  ownerAway?: boolean;
  automationPause?: { kind: "consecutive" | "total"; reason: string };
  paths?: readonly { lexical: string; canonical: string; effect: "read" | "write" }[];
  admissionDenial?: { code: string; reason: string };
  floor?: { code: PermissionFloorCode; reason: string };
  rules?: { deny?: string; ask?: string; allow?: string; remembered?: string };
  secretRead?: boolean;
  fileWrite?: { insideProject: boolean; checkpointAvailable: boolean; directoryApproved?: boolean };
  shell?: { sandboxed: boolean; readOnlyProven: boolean; unproven: boolean; destructive: boolean; escalated?: boolean };
  reviewer?: { level?: "low" | "medium" | "high"; status: "success" | "error" | "abort"; breakerOpen?: boolean };
  manualRerun?: boolean;
  userOwnedSurface?: { kind: UserOwnedSurface; choice: UserOwnedSurfaceChoice };
}

export interface PermissionPipelineDecision {
  outcome: PermissionPipelineOutcome;
  reasonCode: string;
  reason: string;
  reviewRequired?: true;
  requiresCodeCheckpoint?: true;
}

export const NO_APPROVER_MESSAGE = "Nobody can approve this request; do not retry.";

function askHuman(request: PermissionDecisionRequest, reasonCode: string, reason: string): PermissionPipelineDecision {
  return request.headless
    ? { outcome: "deny", reasonCode: "no-approver", reason: NO_APPROVER_MESSAGE }
    : { outcome: "ask", reasonCode, reason };
}

function applyMode(request: PermissionDecisionRequest, reasonCode: string, reason: string): PermissionPipelineDecision {
  if (request.mode === "allow") return { outcome: "allow", reasonCode: "allow-mode", reason: "The mode allows this action." };
  if (request.mode !== "auto") return askHuman(request, reasonCode, reason);

  if (request.automationPause) return askHuman(request, "automation-paused", request.automationPause.reason);
  const reviewer = request.reviewer;
  if (!reviewer) {
    return { outcome: "ask", reasonCode: "review-required", reason: "Automatic review is required.", reviewRequired: true };
  }
  if (!reviewer.breakerOpen && reviewer.status === "success" && (reviewer.level === "low" || reviewer.level === "medium")) {
    return { outcome: "allow", reasonCode: "reviewer-allow", reason: "Automatic review allowed this action." };
  }
  return askHuman(request, "reviewer-human-required", "Automatic review requires human approval.");
}

/** Applies the ordered stages in docs/architecture/permission-decision-tree.md. */
export function decidePermission(request: PermissionDecisionRequest): PermissionPipelineDecision {
  if (request.admissionDenial) {
    return { outcome: "deny", reasonCode: request.admissionDenial.code, reason: request.admissionDenial.reason };
  }
  if (request.rules?.deny !== undefined) {
    return { outcome: "deny", reasonCode: "rule-deny", reason: request.rules.deny };
  }
  if (!["read", "write", "file-write", "shell", "network", "mcp"].includes(request.tool.kind)) {
    return { outcome: "deny", reasonCode: "unsupported-tool-kind", reason: "The tool kind is not supported by the permission contract." };
  }
  if (request.floor) {
    return request.headless
      ? { outcome: "deny", reasonCode: "no-approver", reason: NO_APPROVER_MESSAGE }
      : { outcome: "ask-forced", reasonCode: request.floor.code, reason: request.floor.reason };
  }
  if (request.manualRerun) return askHuman(request, "manual-rerun", "The rerun requires fresh human approval.");
  if (request.rules?.ask !== undefined) {
    return request.userOwnedSurface
      ? askHuman(request, "rule-ask", request.rules.ask)
      : applyMode(request, "rule-ask", request.rules.ask);
  }
  if (request.userOwnedSurface) {
    if (request.headless) return { outcome: "deny", reasonCode: "no-approver", reason: NO_APPROVER_MESSAGE };
    if (request.userOwnedSurface.choice === "allow") return { outcome: "allow", reasonCode: "user-owned-surface-allow", reason: "The user allowed this surface for the session." };
    if (request.userOwnedSurface.choice === "auto") {
      if (request.automationPause) return askHuman(request, "automation-paused", request.automationPause.reason);
      if (!request.reviewer) return { outcome: "ask", reasonCode: "user-owned-surface-review", reason: "Logical consistency review is required.", reviewRequired: true };
      if (request.reviewer.status === "success" && request.reviewer.level === "low" && !request.reviewer.breakerOpen) return { outcome: "allow", reasonCode: "user-owned-surface-reviewed", reason: "The action follows the user's request." };
      return askHuman(request, "user-owned-surface-human-required", "The action needs human confirmation.");
    }
    return askHuman(request, "user-owned-surface-ask", "Choose how to approve actions on this user-owned surface.");
  }
  if (request.rules?.allow !== undefined) {
    return { outcome: "allow", reasonCode: "rule-allow", reason: request.rules.allow };
  }
  if (request.rules?.remembered !== undefined) {
    return { outcome: "allow", reasonCode: "remembered-approval", reason: request.rules.remembered };
  }
  if (request.secretRead) return applyMode(request, "secret-read", "Reading this secret file requires approval.");
  if (request.tool.kind === "mcp" || request.tool.source === "mcp") {
    return request.tool.readOnlyHint === true
      ? { outcome: "allow", reasonCode: "read-only-tool", reason: "The tool declares a read-only action." }
      : applyMode(request, "external-tool", "This tool requires approval.");
  }
  if (request.tool.kind === "read") return { outcome: "allow", reasonCode: "ordinary-read", reason: "Ordinary reads are allowed." };
  if (request.tool.kind === "file-write" || request.tool.kind === "write") {
    if (request.mode !== "strict" && request.fileWrite?.insideProject && request.fileWrite.checkpointAvailable) {
      return { outcome: "allow", reasonCode: "project-write", reason: "The project write can be restored.", requiresCodeCheckpoint: true };
    }
    return applyMode(request, "file-write", "This write requires approval.");
  }
  if (request.tool.kind === "shell") {
    const shell = request.shell;
    if (shell?.sandboxed && !shell.escalated && !shell.unproven && !shell.destructive) {
      if (shell.readOnlyProven) return { outcome: "allow", reasonCode: "read-only-shell", reason: "The sandboxed shell action is proven read-only." };
      if (request.mode !== "strict") return { outcome: "sandbox-auto", reasonCode: "sandboxed-shell", reason: "The sandbox confines this shell action." };
    }
    return applyMode(request, "shell-approval", "This shell action requires approval.");
  }
  if (request.tool.kind === "network") return applyMode(request, "network-approval", "This network action requires approval.");
  return { outcome: "deny", reasonCode: "unsupported-tool-kind", reason: "The tool kind is not supported by the permission contract." };
}
