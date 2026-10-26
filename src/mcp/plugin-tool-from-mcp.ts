/** Register all plugin tools with natural identity and the strict host risk baseline.
 * Wire sandbox, worker and risk claims never authorize review relaxation. */
import { createDynamicTool, type Tool } from "../tools/base.js";
import {
  FAIL_CLOSED_SURFACE,
  parseToolSurfaces,
  type ToolSurface,
} from "../plugins/runtime/tool-visibility.js";
import { createLogger } from "../lib/logger.js";
import type { McpToolCallOutput } from "./types.js";
import { prepareMcpContentImage } from "./mcp-tool-content.js";
import type { PluginToolOperationPolicy } from "../tools/plugin-operation-governance.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("plugin-tool-from-mcp");

const AVE_META_PREFIX = "ave/";

/** Wire metadata is opaque and untrusted; extract authority defensively. */
export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Box raw return values to distinguish absent results from present undefined values. */
export type PluginMcpInvoke = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpToolCallOutput & { rawResult?: { value: unknown } }>;

function readPathFields(meta: Record<string, unknown>): string[] | undefined {
  // Only owned pathFields metadata supplies extraction rules; schema admission rejects misplaced authority.
  const value = meta[`${AVE_META_PREFIX}pathFields`];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

/** Missing or malformed explicit visibility indicates a broken producer; warn and narrow to model-only. */
function readToolSurfaces(toolName: string, meta: Record<string, unknown>): readonly ToolSurface[] {
  const ui = meta.ui;
  const raw =
    typeof ui === "object" && ui !== null && !Array.isArray(ui)
      ? (ui as Record<string, unknown>).visibility
      : undefined;
  const parsed = parseToolSurfaces(raw);
  if (parsed) return parsed;
  log.warn(
    `plugin tool '${toolName}' arrived over the loopback with no valid _meta.ui.visibility — ` +
      "projection-contract violation; applying fail-closed minimal surface [model]",
  );
  return FAIL_CLOSED_SURFACE;
}

export function mcpToolToPluginTool(
  pluginId: string,
  tool: DiscoveredMcpTool,
  invoke: PluginMcpInvoke,
  operationPolicy?: PluginToolOperationPolicy,
  generationId?: string,
): Tool {
  const meta = tool._meta ?? {};
  // Ignore wire category; effective risk is derived by the host for each invocation.
  const category = "write";

  return createDynamicTool({
    name: tool.name,
    description: tool.description ?? tool.name,
    source: "plugin",
    category,
    pluginId,
    ...(generationId ? { pluginGeneration: { pluginId, generationId } } : {}),
    operationPolicy,
    pathFields: readPathFields(meta),
    // Register app-only tools but hide them from the model; callFromApp alone enforces app visibility.
    modelVisible: readToolSurfaces(tool.name, meta).includes("model"),
    jsonSchema: tool.inputSchema,
    isReadOnly: () => false,
    execute: async (rawInput, ctx) => {
      let parsed: unknown = rawInput ?? {};
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          /* Keep wire strings intact; the server validates them. */
        }
      }
      const args = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
      try {
        const { text, uiPayload, rawResult, images } = await invoke(tool.name, args);
        const { image, note } = await prepareMcpContentImage(images ?? [], ctx?.abortSignal);
        const metadata: Record<string, unknown> = {};
        if (uiPayload) metadata.uiPayload = uiPayload;
        if (rawResult) metadata.rawResult = rawResult.value;
        return {
          output: note ? `${text}\n${note}` : text,
          isError: false,
          ...(Object.keys(metadata).length > 0 && { metadata }),
          ...(image && { image }),
        };
      } catch (err) {
        return {
          output: errorMessage(err),
          isError: true,
        };
      }
    },
  });
}
