import { randomUUID } from "node:crypto";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { workflowOutputSessionPrefix } from "../../shared/workflow-run-view.js";
import { canonicalWorkflowJson } from "../../shared/workflow-template-output.js";
import type { RequestedOutputDecl } from "../../shared/workflow-template-types.js";
import type { Tool } from "../../tools/base.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { GovernedOutputAdapter } from "../../work-board/workflow/requested-outputs.js";

export function governedWorkflowOutput(registry: ToolRegistry, executor: ToolExecutor): GovernedOutputAdapter {
  const resolveTool = (decl: RequestedOutputDecl): Tool | undefined => {
    const tool = registry.findByName(decl.toolName);
    if (decl.owner === "server" && tool?.source === "mcp" && tool.mcpServerId === decl.ownerId) return tool;
    if (decl.owner === "plugin" && tool?.source === "plugin" && tool.pluginId === decl.ownerId) return tool;
  };

  return {
    async invoke({ run, output, surface, signal, cwd, canExecute }) {
      const { decl } = output;
      const tool = resolveTool(decl);
      if (!tool) return "failed";
      const sessionId = workflowOutputSessionPrefix(run.itemId, run.runId) + randomUUID();
      updateApprovalSurface({ kind: "attach", sessionId, surface });
      try {
        let dispatched = false;
        let bindingChanged = false;
        const [result] = await executor.executeAll([{ id: output.id, name: decl.toolName, input: JSON.parse(output.args) }], {
          executionCwd: cwd,
          sessionId,
          abortSignal: signal,
          permissionContext: { trustOrigin: "agent-message", otherPrincipal: true },
          approvedInvocation: (candidate, input) => {
            if (dispatched || candidate !== tool || resolveTool(decl) !== tool
              || canonicalWorkflowJson(input) !== output.args || signal.aborted || !canExecute() || surface.isDestroyed()) {
              bindingChanged = true;
              return false;
            }
            dispatched = true;
            return true;
          },
        });
        if (bindingChanged || !result || (dispatched && result.is_error)) return "failed";
        return dispatched ? "done" : "denied";
      } finally {
        updateApprovalSurface({ kind: "release", sessionId });
      }
    },
  };
}
