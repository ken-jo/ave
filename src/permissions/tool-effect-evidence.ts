import type { EnvelopeToolRef } from "../shared/workflow-template-types.js";
import type { ToolRegistry } from "../tools/registry.js";

export type ToolEffectEvidence = "outward" | "safe" | "unknown";

export interface ToolEffectResolver {
  effectOf(tool: Pick<EnvelopeToolRef, "collection" | "name">): ToolEffectEvidence;
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
    effectOf({ collection, name }) {
      const tool = registry.findByName(name);
      return tool?.source === TOOL_SOURCE_BY_COLLECTION[collection] ? tool.unattendedEffect ?? "unknown" : "unknown";
    },
  };
}
