import { randomUUID } from "node:crypto";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { workflowOutputSessionPrefix } from "../../shared/workflow-run-view.js";
import { canonicalWorkflowJson } from "../../shared/workflow-template-output.js";
import type { RequestedOutputDecl } from "../../shared/workflow-template-types.js";
import type { Tool } from "../../tools/base.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { GovernedOutputAdapter } from "../../work-board/workflow/requested-outputs.js";
import type { WorkDecisionAuthority } from "../../work-board/work-decision-authority.js";

export function governedWorkflowOutput(registry: ToolRegistry, executor: ToolExecutor, gate: ApprovalGate, transportEndpoint?: (serverId: string) => string | undefined): GovernedOutputAdapter {
  const resolveTool = (decl: RequestedOutputDecl): Tool | undefined => {
    const tool = registry.findByName(decl.toolName);
    if (decl.owner === "server" && tool?.source === "mcp" && tool.mcpServerId === decl.ownerId) return tool;
    if (decl.owner === "plugin" && tool?.source === "plugin" && tool.pluginId === decl.ownerId) return tool;
  };

  return {
    async invoke({ output, surface, signal, cwd, canExecute, binding, controller, projectRoot }) {
      const { decl } = output;
      const tool = resolveTool(decl);
      if (!tool || (tool.source !== "plugin" && tool.source !== "mcp")) return "output-execution-not-dispatched";
      if (!canExecute() || signal.aborted || (!controller && surface?.isDestroyed() !== false && !gate.hasRequestedOutputPage(projectRoot))) return "denied";
      const sessionId = workflowOutputSessionPrefix(binding.itemId, binding.runId) + randomUUID();
      const remoteControllerAuthority = controller === undefined ? undefined : bindRemoteControllerToSession(controller, sessionId);
      if (surface && !surface.isDestroyed()) updateApprovalSurface({ kind: "attach", sessionId, surface });
      else updateApprovalSurface({ kind: "attach-project", sessionId, project: { itemId: binding.itemId, projectRoot } });
      let winner: WorkDecisionAuthority | undefined;
      let displayRefused = false;
      const endpoint = () => tool.source === "mcp" ? transportEndpoint?.(decl.ownerId) : undefined;
      const serviceEndpoint = endpoint();
      const release = gate.bindRequestedOutput(sessionId, {
        binding: { ...binding, outputId: output.id }, toolName: tool.name, source: tool.source, ownerId: decl.ownerId, projectRoot, serviceEndpoint,
        signal, canExecute, refuseDisplay: () => { displayRefused = true; }, recordWinner: accepted => { winner = accepted; },
      });
      try {
        let dispatched = false;
        let bindingChanged = false;
        const [result] = await executor.executeAll([{ id: output.id, name: decl.toolName, input: JSON.parse(output.args) }], {
          executionCwd: cwd,
          sessionId,
          abortSignal: signal,
          permissionContext: { trustOrigin: "agent-message", otherPrincipal: true, remoteControllerAuthority },
          refreshApprovedInvocation: async () => winner !== undefined && canExecute() && await winner.refreshCurrent(),
          approvedInvocation: (candidate, input) => {
            if (dispatched || candidate !== tool || resolveTool(decl) !== tool || endpoint() !== serviceEndpoint
              || canonicalWorkflowJson(input) !== output.args || signal.aborted || !canExecute() || winner?.isCurrent() !== true) {
              bindingChanged = true;
              return false;
            }
            dispatched = true;
            return true;
          },
        });
        if (displayRefused) return "output-args-not-displayable";
        if (bindingChanged || signal.aborted && !dispatched) return dispatched ? "failed" : "output-execution-not-dispatched";
        if (!result || (dispatched && result.is_error)) return "failed";
        return dispatched ? "done" : "denied";
      } finally {
        release();
        updateApprovalSurface({ kind: "release", sessionId });
      }
    },
  };
}
