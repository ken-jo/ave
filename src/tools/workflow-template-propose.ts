import { z } from "zod";
import { t } from "../i18n/index.js";
import { resolveAuthorizedWorkspaceProject } from "../main/project-root-authorization.js";
import type { WorkflowTemplateStore } from "../main/workflow-template-store.js";
import { currentEffectGateContext } from "../permissions/effect-enforcement.js";
import { WORKFLOW_TEMPLATE_PROPOSE_TOOL } from "../shared/workflow-template-types.js";
import { isStageId, isWorkspaceGlob, WorkflowTemplateError } from "../work-board/template-graph.js";
import { createDynamicTool, toolErrorResult, type Tool } from "./base.js";

const MAX_DRAFT_BYTES = 256 * 1024;
const nonBlank = (max: number) => z.string().max(max).regex(/\S/);
const stageId = z.string().refine(isStageId);
const stringList = z.array(nonBlank(2048)).max(256);
const workspaceGlob = z.string().refine(isWorkspaceGlob);
const outputKind = z.enum(["upload", "send-message", "publish-post", "external-write", "other"]);
const generationTool = z.strictObject({
  name: nonBlank(256),
  effect: z.enum(["generate", "fetch"]),
  dataSent: z.boolean(),
});
const envelope = z.strictObject({
  writePaths: z.array(workspaceGlob).max(256),
  readRoots: stringList,
  tools: stringList,
  network: z.array(z.strictObject({
    host: z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i),
    port: z.number().int().min(1).max(65535).optional(),
  })).max(256),
  commands: stringList,
  mcpReadOnlyTools: stringList,
  mcpGenerationTools: z.array(generationTool).max(256),
  pluginGenerationTools: z.array(generationTool).max(256),
  outputs: z.array(z.union([z.literal("branch"), outputKind])).max(256),
  budget: z.strictObject({ rounds: z.int().positive(), minutes: z.number().positive(), costUsd: z.number().nonnegative() }),
});

// The model surface requires every envelope field and stage toggle explicitly.
// Stored graphs continue to use their existing canonicalization contract.
const draftSchema = z.strictObject({
  name: nonBlank(60),
  description: z.string().max(8192).optional(),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({ kind: z.literal("project"), projectRoot: nonBlank(2048) }),
  ]),
  stages: z.array(z.strictObject({
    id: stageId,
    name: nonBlank(40),
    goal: nonBlank(400),
    kind: z.literal("plan").optional(),
    inputs: z.array(stageId).max(12).refine(inputs => new Set(inputs).size === inputs.length),
    toolScope: z.enum(["read", "all"]),
    agentName: nonBlank(128).optional(),
    allowSubAgents: z.boolean(),
    gate: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("human") }),
      z.strictObject({ type: z.literal("auto"), pass: z.strictObject({ kind: z.enum(["stage_ok", "model_verdict"]) }) }),
    ]),
    envelope: envelope.optional(),
    inputFiles: z.array(z.discriminatedUnion("from", [
      z.strictObject({ from: z.literal("stage"), stageId }),
      z.strictObject({ from: z.literal("project"), paths: z.array(workspaceGlob).max(64) }),
    ])).max(64).optional(),
    outputs: z.array(workspaceGlob).max(32).optional(),
    requestedOutputs: z.array(z.strictObject({
      kind: outputKind,
      toolName: nonBlank(256),
      owner: z.enum(["host", "server", "plugin"]),
      ownerId: nonBlank(256),
    })).max(256).optional(),
  })).min(1).max(12),
  edges: z.array(z.strictObject({ from: stageId, to: stageId })).max(132),
  setupCommands: z.array(nonBlank(8192)).max(256).optional(),
});

export function createWorkflowTemplateProposeTool(store: WorkflowTemplateStore): Tool {
  return createDynamicTool({
    name: WORKFLOW_TEMPLATE_PROPOSE_TOOL,
    description: t("be_workflowTemplates.proposeToolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: z.toJSONSchema(draftSchema),
    execute: async (raw, ctx) => {
      if (ctx.headless !== false || currentEffectGateContext()?.permissionContext?.ownerUnattended) {
        return toolErrorResult("human-confirmation-unavailable");
      }
      const parsed = draftSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
        return { isError: true, output: JSON.stringify({ error: "invalid-input", field: path.join(".") || "draft" }) };
      }
      if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_DRAFT_BYTES) {
        return { isError: true, output: JSON.stringify({ error: "too-many-entries", field: "draft" }) };
      }
      try {
        const draft = parsed.data;
        if (draft.scope.kind === "project") {
          const resolved = resolveAuthorizedWorkspaceProject(draft.scope.projectRoot);
          if (!resolved.authorized || !resolved.project) {
            return { isError: true, output: JSON.stringify({ error: "scope-not-authorised", field: "scope.projectRoot" }) };
          }
          draft.scope = { kind: "project", projectRoot: resolved.project.projectRoot };
        }
        const { id, graphHash } = store.propose(draft);
        return { isError: false, output: JSON.stringify({ status: "pending-confirmation", proposalId: id, graphHash }) };
      } catch (error) {
        if (!(error instanceof WorkflowTemplateError)) throw error;
        return { isError: true, output: JSON.stringify({ error: error.code, field: error.field ?? "draft", refusals: error.refusals }) };
      }
    },
  });
}
