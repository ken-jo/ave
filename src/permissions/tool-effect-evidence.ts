import type { EnvelopeToolRef, StageEnvelope } from "../shared/workflow-template-types.js";
import { isModelExposedTool, isUnattendedReadTool, type Tool } from "../tools/base.js";
import type { ToolRegistry } from "../tools/registry.js";

export type ToolEffectEvidence = "outward" | "safe" | "unknown";

export interface ToolEffectResolver {
  effectOf(tool: Pick<EnvelopeToolRef, "collection" | "name">): ToolEffectEvidence;
  isFixedLocalRead?(name: string): boolean;
}

const TOOL_SOURCE_BY_COLLECTION = {
  tools: "builtin",
  mcpReadOnlyTools: "mcp",
  mcpGenerationTools: "mcp",
  pluginGenerationTools: "plugin",
} as const;

export interface ExternalEffectAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
}

export function effectFromAnnotations(annotations: ExternalEffectAnnotations | undefined): ToolEffectEvidence {
  if (annotations === undefined) return "unknown";
  const { readOnlyHint, destructiveHint, openWorldHint } = annotations;
  if ([readOnlyHint, destructiveHint, openWorldHint].some(value => value !== undefined && typeof value !== "boolean")) return "unknown";
  if (readOnlyHint === true && destructiveHint !== true) return "safe";
  if (readOnlyHint === false && openWorldHint === true) return "outward";
  return "unknown";
}

export function createToolEffectResolver(registry: Pick<ToolRegistry, "findByName">): ToolEffectResolver {
  return {
    isFixedLocalRead(name) {
      const tool = registry.findByName(name);
      return tool !== undefined && isUnattendedReadTool(tool);
    },
    effectOf({ collection, name }) {
      const tool = registry.findByName(name);
      return tool?.source === TOOL_SOURCE_BY_COLLECTION[collection] ? tool.unattendedEffect ?? "unknown" : "unknown";
    },
  };
}

export function unattendedEnvelopeTool(tool: Tool, envelope: StageEnvelope, effects: ToolEffectResolver): boolean {
  if (!isModelExposedTool(tool) || tool.requiresAttendedStage || tool.arbitraryEgress || tool.requiresMcpScope || tool.appInvokable) return false;
  const { name, source } = tool;
  if (source === "builtin") return envelope.tools.includes(name) && effects.effectOf({ collection: "tools", name }) === "safe";
  if (source === "plugin") {
    return envelope.pluginGenerationTools.some(entry => entry.name === name)
      && effects.effectOf({ collection: "pluginGenerationTools", name }) === "safe";
  }
  return (envelope.mcpReadOnlyTools.includes(name) && effects.effectOf({ collection: "mcpReadOnlyTools", name }) === "safe")
    || (envelope.mcpGenerationTools.some(entry => entry.name === name) && effects.effectOf({ collection: "mcpGenerationTools", name }) === "safe");
}
