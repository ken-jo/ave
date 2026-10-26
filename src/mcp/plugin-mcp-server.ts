/** Transport-independent stateless plugin server; requests carry client metadata and protocol version. */
import type { PluginManifest } from "../plugins/types.js";
import {
  manifestToDiscoverResult,
  manifestToolsToMcpTools,
} from "./plugin-server-projection.js";
import {
  MCP_APP_MIME_TYPE,
  type PluginUiResourceProvider,
} from "./plugin-ui-resource-provider.js";
import type { McpUiResourceMeta } from "./types.js";

import {
  INVOCATION_META,
  MCP_PROTOCOL_VERSION,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  RPC_METHOD_NOT_FOUND,
  RPC_RESOURCE_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_UNSUPPORTED_PROTOCOL_VERSION,
} from "./protocol-constants.js";
import { PLUGIN_RESULT_CACHE } from "./plugin-server-projection.js";
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "./mcp-client.js";
import { errorMessage } from "../shared/error-message.js";

interface PluginToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface PluginToolOutcome {
  content: PluginToolContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export type PluginToolDelegate = (
  name: string,
  args: Record<string, unknown>,
  /** Present only for work bound to a host invocation token. */
  context?: { readonly invocation: string },
) => Promise<PluginToolOutcome>;

export class PluginMcpServer {
  constructor(
    private readonly manifest: PluginManifest,
    private readonly callTool: PluginToolDelegate,
    /** Without a provider, resource reads fail closed and resource listing is empty. */
    private readonly uiResources?: PluginUiResourceProvider,
  ) {}

  /** Tool failures return isError results; protocol failures use JSON-RPC errors.
     * Stamp server identity only on results. */
  async handle(request: JsonRpcRequest<JsonRpcId>): Promise<JsonRpcResponse<JsonRpcId>> {
    const response = await this.dispatch(request);
    if (
      response.result !== undefined &&
      response.result !== null &&
      typeof response.result === "object" &&
      !Array.isArray(response.result)
    ) {
      const result = response.result as { _meta?: Record<string, unknown> };
      result._meta = {
        ...result._meta,
        [META_SERVER_INFO]: {
          name: this.manifest.name ?? this.manifest.id,
          version: this.manifest.version,
        },
      };
    }
    return response;
  }

  private async dispatch(request: JsonRpcRequest<JsonRpcId>): Promise<JsonRpcResponse<JsonRpcId>> {
    const id = request.id;

    const versionError = this.checkProtocolVersion(request.params);
    if (versionError) {
      return { jsonrpc: "2.0", id, error: versionError };
    }

    switch (request.method) {
      case "server/discover":
        return { jsonrpc: "2.0", id, result: manifestToDiscoverResult(this.manifest) };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ...PLUGIN_RESULT_CACHE,
            tools: manifestToolsToMcpTools(this.manifest),
          },
        };

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ...PLUGIN_RESULT_CACHE,
            resources: this.uiResources?.list() ?? [],
          },
        };

      case "resources/read": {
        const params = request.params ?? {};
        const uri = params.uri;
        if (typeof uri !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: RPC_INVALID_PARAMS, message: "resources/read requires a string 'uri'" },
          };
        }
        // No provider means no served UI; namespace, declaration and containment checks remain mandatory.
        if (!this.uiResources) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: RPC_RESOURCE_NOT_FOUND, message: `Resource not found: ${uri}` },
          };
        }
        try {
          const resource = await this.uiResources.read(uri);
          const ui: McpUiResourceMeta = {};
          if (resource.csp !== undefined) ui.csp = resource.csp;
          if (resource.permissions !== undefined) ui.permissions = resource.permissions;
          const content: Record<string, unknown> = {
            uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: resource.html,
          };
          if (ui.csp !== undefined || ui.permissions !== undefined) content._meta = { ui };
          return {
            jsonrpc: "2.0",
            id,
            result: { resultType: "complete", ...PLUGIN_RESULT_CACHE, contents: [content] },
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: RPC_RESOURCE_NOT_FOUND,
              message: errorMessage(err),
            },
          };
        }
      }

      case "tools/call": {
        const params = request.params ?? {};
        const name = params.name;
        if (typeof name !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: RPC_INVALID_PARAMS, message: "tools/call requires a string 'name'" },
          };
        }
        const args =
          params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        const meta = params._meta;
        const invocation =
          meta && typeof meta === "object" && !Array.isArray(meta)
            ? (meta as Record<string, unknown>)[INVOCATION_META]
            : undefined;
        try {
          const outcome = typeof invocation === "string"
            ? await this.callTool(name, args, { invocation })
            : await this.callTool(name, args);
          const result: Record<string, unknown> = {
            resultType: "complete",
            content: outcome.content,
          };
          if (outcome.isError !== undefined) result.isError = outcome.isError;
          if (outcome._meta !== undefined) result._meta = outcome._meta;
          return { jsonrpc: "2.0", id, result };
        } catch (err) {
          // A thrown delegate is a tool failure, not a protocol-dispatch error.
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              content: [{ type: "text", text: errorMessage(err) }],
              isError: true,
            },
          };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: RPC_METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
        };
    }
  }

  /** Missing protocol metadata is allowed internally; explicit mismatches are rejected. */
  private checkProtocolVersion(
    params: Record<string, unknown> | undefined,
  ): { code: number; message: string; data?: unknown } | null {
    const meta = params?._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    const requested = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
    if (requested === undefined) return null;
    if (requested === MCP_PROTOCOL_VERSION) return null;
    return {
      code: RPC_UNSUPPORTED_PROTOCOL_VERSION,
      message: `Unsupported protocol version: ${String(requested)}`,
      data: { supported: [MCP_PROTOCOL_VERSION], requested },
    };
  }
}
