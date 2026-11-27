import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { verifiedPluginOperationOperands } from "../../mcp/plugin-mcp-host.js";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import {
  getDefaultSensitiveReadDenyPaths, getUserReadDenies, protectedReadDenyMatcher,
} from "../../permissions/asrt-sandbox.js";
import { PATCH_ENVELOPE_PATH_FIELD_SUFFIX } from "../../shared/dotted-field-value.js";
import { isPlainRecord } from "../../shared/is-record.js";
import { canonicalWorkflowJson } from "../../shared/workflow-template-output.js";
import type { RequestedOutputDecl } from "../../shared/workflow-template-types.js";
import type { Tool } from "../../tools/base.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { withPathFieldDefaults } from "../../tools/pipeline/path-extraction.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { type GovernedOutputAdapter, type OutputOperands, relativeOutputFile } from "../../work-board/workflow/requested-outputs.js";

function bindOperands(tool: Tool | undefined, args: Record<string, unknown>, workspace: string, snapshot?: string): OutputOperands {
  if (!tool) return "output-operands-unverified";
  const verified = tool.source === "builtin" ? tool.pathFields : verifiedPluginOperationOperands(tool, args.operation);
  if (verified === undefined) return "output-operands-unverified";
  const input = withPathFieldDefaults(tool, structuredClone(args));
  const paths = new Set<string>();
  const fields = new Set([...verified, ...Object.keys(tool.pathFieldDefaults ?? {})]);
  for (const field of fields) {
    if (field.endsWith(PATCH_ENVELOPE_PATH_FIELD_SUFFIX)) return "output-operands-unverified";
    const segments = field.split(".");
    const key = segments.pop() ?? "";
    if (!key || segments.some(segment => segment === "")) return "output-operands-unverified";
    let parent: unknown = input;
    for (const segment of segments) {
      if (parent == null) break;
      if (!isPlainRecord(parent)) return "output-operands-unverified";
      parent = Object.hasOwn(parent, segment) ? parent[segment] : undefined;
    }
    if (parent == null) continue;
    if (!isPlainRecord(parent)) return "output-operands-unverified";
    const value = Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (value == null) continue;
    const operands: unknown[] = Array.isArray(value) ? value : [value];
    const mapped: string[] = [];
    for (const operand of operands) {
      if (typeof operand !== "string") return "output-operands-unverified";
      const path = isAbsolute(operand) ? relative(workspace, operand).split(sep).join("/") : operand;
      if (!relativeOutputFile(path)) return "file-outside-workspace";
      paths.add(path);
      if (snapshot !== undefined) mapped.push(join(snapshot, path));
    }
    if (snapshot !== undefined) parent[key] = Array.isArray(value) ? mapped : mapped[0];
  }
  if (paths.size > 0) {
    // Use the worker wrap's floor with live user denies. This invocation has no read grant for a stage workspace.
    const denied = protectedReadDenyMatcher([...getDefaultSensitiveReadDenyPaths(), ...getUserReadDenies()]);
    if ([...paths].some(path => denied(join(workspace, path)) !== undefined)) return "output-file-read-denied";
    if (process.platform === "win32") return "output-file-unbound";
  }
  return { input, paths: [...paths] };
}

export function governedWorkflowOutput(registry: ToolRegistry, executor: ToolExecutor): GovernedOutputAdapter {
  const resolveTool = (decl: RequestedOutputDecl): Tool | undefined => {
    const tool = registry.findByName(decl.toolName);
    if (decl.owner === "server" && tool?.source === "mcp" && tool.mcpServerId === decl.ownerId) return tool;
    if (decl.owner === "plugin" && tool?.source === "plugin" && tool.pluginId === decl.ownerId) return tool;
  };

  return {
    operands: (decl, args, workspace) => bindOperands(resolveTool(decl), args, workspace),
    async invoke({ output, args, root, workspace, surface, recheck }) {
      if (canonicalWorkflowJson(args) !== output.args) return "failed";
      const { decl } = output;
      const tool = resolveTool(decl);
      if (!tool) return "output-operands-unverified";
      const operands = bindOperands(tool, args, workspace, root);
      if (typeof operands === "string") return operands;
      const boundPaths = new Set(output.files?.map(file => file.path));
      if (boundPaths.size !== operands.paths.length || operands.paths.some(path => !boundPaths.has(path))) {
        return "output-operands-unverified";
      }
      const expectedInput = canonicalWorkflowJson(operands.input);
      const sessionId = `workflow-output:${randomUUID()}`;
      updateApprovalSurface({ kind: "attach", sessionId, surface });
      try {
        let dispatched = false;
        let bindingChanged = false;
        const [result] = await executor.executeAll([{ id: output.id, name: decl.toolName, input: operands.input }], {
          executionCwd: root,
          sessionId,
          permissionContext: { trustOrigin: "agent-message", otherPrincipal: true },
          approvedInvocation: async (candidate, input) => {
            if (dispatched || candidate !== tool || resolveTool(decl) !== tool
              || canonicalWorkflowJson(input) !== expectedInput || !await recheck()
              || resolveTool(decl) !== tool) {
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
