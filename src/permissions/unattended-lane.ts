import { isAbsolute, relative, resolve, sep } from "node:path";
import { globMatch } from "../lib/glob-matcher.js";
import { withLocalityDecision } from "../shared/local-path-io.js";
import { relativeNativePath, tryNativeRealpath } from "../shared/shell-filesystem-path.js";
import type { StageGenerationTool } from "../shared/workflow-template-types.js";
import type { PermissionDecisionRequest, PermissionPipelineDecision } from "./decision-pipeline.js";
import type { UnattendedStageEntry } from "./unattended-lane-registry.js";

export type UnattendedDenyCode = "outside-envelope" | "forbidden-unattended" | "isolation-unproven" | "rule-ask" | "exfiltration-guardrail" | "reviewer-denied";
export const UNATTENDED_DENY_MESSAGE = "This call is outside what this scheduled run was confirmed to do; do not retry.";

export function unattendedGenerationTool(request: PermissionDecisionRequest): StageGenerationTool | undefined {
  const envelope = request.unattended?.envelope;
  const { source, name } = request.tool;
  const tools = source === "mcp" ? envelope?.mcpGenerationTools : source === "plugin" ? envelope?.pluginGenerationTools : undefined;
  return tools?.find(tool => tool.name === name);
}

function relativeLexicalPath(root: string, operand: string): string | undefined {
  if (sep !== "\\") return relativeNativePath(root, operand);
  // Windows accepts case aliases in the operand. The resolved target still needs exact native membership.
  const child = relative(root, operand);
  return isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`) ? undefined : child;
}

function insideEnvelope(request: PermissionDecisionRequest, entry: UnattendedStageEntry): { inside: true } | { inside: false; why: string } {
  const { envelope, workspaceRoot } = entry;
  const { source, name, kind } = request.tool;
  const connection = request.unattendedNetwork;
  if (entry.readOnly && (source !== "builtin" || kind !== "read" || connection !== undefined
      || request.paths?.some(path => path.effect === "write"))) {
    return { inside: false, why: "The stage permits only local reads." };
  }
  if (connection !== undefined || source === "builtin" && kind === "network") {
    if (!connection?.sandboxed || !envelope.network.some(target =>
      target.host === connection.host && (target.port === undefined || target.port === connection.port))) {
      return { inside: false, why: "Network target is outside the envelope." };
    }
  }
  // A mediated connection is already bound to the sandbox that initiated it.
  // Ordinary tool calls must additionally identify a declared tool.
  if (!(kind === "network" && connection?.connection === true)) {
    const declared = source === "builtin" ? envelope.tools.includes(name)
      : source === "mcp" ? envelope.mcpReadOnlyTools.includes(name) || envelope.mcpGenerationTools.some(tool => tool.name === name)
      : source === "plugin" && envelope.pluginGenerationTools.some(tool => tool.name === name);
    if (!declared || request.unattendedEffect !== "safe") return { inside: false, why: "Tool lacks safe envelope evidence." };
  }
  const paths = request.paths ?? [];
  const writes = kind === "file-write" || source === "builtin" && kind === "write";
  if ((writes || paths.some(path => path.effect === "write")) && !request.fileWrite?.checkpointAvailable) {
    return { inside: false, why: "Write has no checkpoint." };
  }
  if (writes && source === "builtin" && !paths.some(path => path.effect === "write")) {
    return { inside: false, why: "Write has no verified target." };
  }
  if (paths.length > 0 && !withLocalityDecision(() => {
    const roots = [workspaceRoot, ...envelope.readRoots].flatMap(root => {
      const physical = isAbsolute(root) ? tryNativeRealpath(root) : undefined;
      return physical === undefined ? [] : [{ lexical: resolve(root), physical, workspace: root === workspaceRoot }];
    });
    return paths.every(({ lexical, runtimePath, effect }) => {
      if (!isAbsolute(lexical) || runtimePath === undefined) return false;
      const operand = resolve(lexical);
      if (effect === "read") {
        return roots.some(root => relativeLexicalPath(root.lexical, operand) !== undefined)
          && roots.some(root => relativeNativePath(root.physical, runtimePath) !== undefined);
      }
      const workspace = roots.find(root => root.workspace);
      if (workspace === undefined) return false;
      return [relativeLexicalPath(workspace.lexical, operand), relativeNativePath(workspace.physical, runtimePath)].every(child =>
        child !== undefined && child !== "" && envelope.writePaths.some(pattern =>
          globMatch(child.split(sep).join("/"), pattern, { caseInsensitive: false, normalizeSeparators: sep === "\\" })));
    });
  })) {
    return { inside: false, why: "Target is outside the envelope." };
  }
  if (kind === "shell" && (!request.unattendedCommand?.length || !request.unattendedCommand.every(command =>
    envelope.commands.some(prefix => command === prefix || command.startsWith(`${prefix} `) || command.startsWith(`${prefix}\t`))))) {
    return { inside: false, why: "Command is outside the envelope." };
  }
  return { inside: true };
}

function deny(code: UnattendedDenyCode): PermissionPipelineDecision {
  return { outcome: "deny", reasonCode: code, reason: UNATTENDED_DENY_MESSAGE };
}

export function decideUnattended(request: PermissionDecisionRequest): PermissionPipelineDecision {
  if (request.floor) return deny("forbidden-unattended");
  if (!request.unattended || (!request.unattended.readOnly && !request.unattended.isolation.proven)) return deny("isolation-unproven");
  if (request.rules?.ask !== undefined) return deny("rule-ask");
  if (request.exfiltration) return deny("exfiltration-guardrail");
  const shell = request.tool.kind === "shell";
  if (request.userOwnedSurface || request.agentBrowser || request.secretRead || request.manualRerun ||
    shell && (!request.shell?.sandboxed || request.shell.escalated)) return deny("forbidden-unattended");
  if (!insideEnvelope(request, request.unattended).inside) return deny("outside-envelope");

  const checkpoint = request.paths?.some(path => path.effect === "write") || request.tool.kind === "file-write";
  const decision: PermissionPipelineDecision = {
    outcome: shell ? "sandbox-auto" : "allow",
    reasonCode: "unattended-envelope",
    reason: "The confirmed envelope allows this call.",
    ...(checkpoint ? { requiresCodeCheckpoint: true } : {}),
  };
  const review = (request.tool.kind !== "network" || request.unattendedNetwork?.connection !== true) &&
    (request.tool.source === "mcp" || request.tool.source === "plugin") ||
    shell && (request.shell?.unproven || request.shell?.destructive);
  if (!review) return decision;
  const reviewer = request.reviewer;
  if (!reviewer) return { ...deny("reviewer-denied"), reviewRequired: true };
  if (request.automationPause || reviewer.breakerOpen || reviewer.status !== "success" ||
    (reviewer.level !== "low" && reviewer.level !== "medium")) return deny("reviewer-denied");
  return { ...decision, outcome: "allow", reasonCode: "reviewer-allow", reason: "Automatic review allowed this action." };
}
