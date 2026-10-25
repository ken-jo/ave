/** Project every normalized tool with explicit visibility and whitelisted metadata.
 * Host-derived annotations and risk never come from plugin self-claims. */
import type {
  PluginManifest,
  PluginToolOperationPolicy,
  Tool as McpTool,
} from "../plugins/types.js";
import { toolVisibility } from "../plugins/runtime/tool-visibility.js";

import { MCP_PROTOCOL_VERSION } from "./protocol-constants.js";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Generation-static catalogs use private caching; reload retires the transport before cached data can outlive it. */
export const PLUGIN_RESULT_CACHE = {
  ttlMs: 3_600_000,
  cacheScope: "private",
} as const satisfies { ttlMs: number; cacheScope: "public" | "private" };

/** Projection excludes plugin annotations and carries only explicit visibility and signed restriction keys. */
export interface McpToolProjection {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    $schema: string;
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  outputSchema?: McpTool["outputSchema"];
  icons?: McpTool["icons"];
  _meta: {
    ui: { visibility: Array<"model" | "app"> };
    "ave/pathFields"?: string[];
    "ave/operationPolicy"?: PluginToolOperationPolicy;
  };
}

export interface McpDiscoverProjection {
  resultType: "complete";
  ttlMs: number;
  cacheScope: "public" | "private";
  supportedVersions: string[];
  serverInfo: { name: string; version: string; description: string };
  capabilities: {
    tools?: { listChanged: boolean };
    extensions?: Record<string, unknown>;
  };
  instructions: string;
}

// Read authority only from the owned metadata namespace.
function toWireTool(tool: McpTool): McpToolProjection {
  const meta: McpToolProjection["_meta"] = { ui: { visibility: toolVisibility(tool) } };
  // Reject misplaced authority at schema admission rather than silently erasing its constraints.
  const pathFields = tool._meta?.["ave/pathFields"];
  if (pathFields !== undefined) {
    meta["ave/pathFields"] = pathFields;
  }
  const operationPolicy = tool._meta?.["ave/operationPolicy"];
  if (operationPolicy !== undefined) {
    meta["ave/operationPolicy"] = operationPolicy;
  }
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description ?? tool.name,
    inputSchema: { ...tool.inputSchema, $schema: JSON_SCHEMA_2020_12 },
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.icons !== undefined ? { icons: tool.icons } : {}),
    _meta: meta,
  };
}

/** Keep app-only tools registered for governance; visibility removes them only at model exposure. */
export function manifestToolsToMcpTools(manifest: PluginManifest): McpToolProjection[] {
  return (manifest.tools ?? []).map((t) => toWireTool(t));
}

/** Derive protocol capabilities from actual contributions, never internal dependency metadata. */
export function manifestToDiscoverResult(manifest: PluginManifest): McpDiscoverProjection {
  const capabilities: McpDiscoverProjection["capabilities"] = {};
  if ((manifest.tools?.length ?? 0) > 0) {
    // Static per-generation servers have no notification emitter, so listChanged must be false.
    capabilities.tools = { listChanged: false };
  }
  const extensions: Record<string, unknown> = {};
  // Panels or declared card resources require the Apps extension advertisement.
  if ((manifest.ui?.length ?? 0) > 0 || (manifest.uiResources?.length ?? 0) > 0) {
    extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] };
  }
  if (Object.keys(extensions).length > 0) {
    capabilities.extensions = extensions;
  }
  return {
    resultType: "complete",
    ...PLUGIN_RESULT_CACHE,
    supportedVersions: [MCP_PROTOCOL_VERSION],
    serverInfo: {
      name: manifest.name ?? manifest.id,
      version: manifest.version,
      description: manifest.description,
    },
    capabilities,
    instructions: manifest.description,
  };
}
