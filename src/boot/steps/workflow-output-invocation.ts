import { randomUUID } from "node:crypto";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { selectDeclaredPathValues } from "../../shared/dotted-field-value.js";
import { canonicalWorkflowJson } from "../../shared/workflow-template-output.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { withPathFieldDefaults } from "../../tools/pipeline/path-extraction.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { GovernedOutputCall } from "../../work-board/workflow/requested-outputs.js";

const STANDARD_FILE_FIELDS = ["path", "file_path", "filePath"] as const;

export function governedWorkflowOutput(registry: ToolRegistry, executor: ToolExecutor): GovernedOutputCall {
  return async ({ output, args, root, surface, recheck }) => {
    const { decl } = output;
    const tool = registry.findByName(decl.toolName);
    if (!tool || (decl.owner === "server" ? tool.source !== "mcp" || tool.mcpServerId !== decl.ownerId
      : decl.owner !== "plugin" || tool.source !== "plugin" || tool.pluginId !== decl.ownerId)) return "denied";
    const input = withPathFieldDefaults(tool, args);
    const pathFields = [...STANDARD_FILE_FIELDS, ...tool.pathFields ?? [], ...Object.keys(tool.pathFieldDefaults ?? {})];
    try {
      if (pathFields.some(field => selectDeclaredPathValues(input, field).some(value => value !== undefined && value !== null))) {
        return "output-file-unbound";
      }
    } catch { return "output-file-unbound"; }
    const sessionId = `workflow-output:${randomUUID()}`;
    updateApprovalSurface({ kind: "attach", sessionId, surface });
    try {
      let dispatched = false;
      let bindingChanged = false;
      const [result] = await executor.executeAll([{ id: output.id, name: decl.toolName, input: args }], {
        executionCwd: root,
        sessionId,
        permissionContext: { trustOrigin: "agent-message", otherPrincipal: true },
        approvedInvocation: async (candidate, input) => {
          if (dispatched || candidate !== tool || registry.findByName(decl.toolName) !== tool
            || canonicalWorkflowJson(input) !== output.args || !await recheck()) {
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
  };
}
