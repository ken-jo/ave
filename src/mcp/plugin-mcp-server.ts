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
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MCP_TASKS_EXTENSION } from "./task-protocol.js";
import { pluginTaskStore, type McpTaskStore } from "./task-store.js";
import type { JsonRpcNotification } from "./mcp-client.js";
import { META_CLIENT_CAPABILITIES, RPC_MISSING_REQUIRED_CLIENT_CAPABILITY, RPC_INTERNAL_ERROR } from "./protocol-constants.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugin-mcp-server");

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
  private readonly subscriptions = new Map<JsonRpcId, () => void>();

  constructor(
    private readonly manifest: PluginManifest,
    private readonly callTool: PluginToolDelegate,
    /** Without a provider, resource reads fail closed and resource listing is empty. */
    private readonly uiResources?: PluginUiResourceProvider,
    private readonly taskStore?: McpTaskStore,
  ) {}

  private get tasks(): McpTaskStore {
    return this.taskStore ?? pluginTaskStore(this.manifest.id);
  }

  closeSubscriptions(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  /** Tool failures return isError results; protocol failures use JSON-RPC errors.
     * Stamp server identity only on results. */
  async handle(
    request: JsonRpcRequest<JsonRpcId>,
    notify?: (notification: JsonRpcNotification) => void,
  ): Promise<JsonRpcResponse<JsonRpcId>> {
    let response: JsonRpcResponse<JsonRpcId>;
    try {
      response = await this.dispatch(request, notify);
    } catch {
      response = { jsonrpc: "2.0", id: request.id, error: { code: RPC_INTERNAL_ERROR, message: "Task operation failed" } };
    }
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

  private async dispatch(request: JsonRpcRequest<JsonRpcId>, notify?: (notification: JsonRpcNotification) => void): Promise<JsonRpcResponse<JsonRpcId>> {
    const id = request.id;

    const versionError = this.checkProtocolVersion(request.params);
    if (versionError) {
      return { jsonrpc: "2.0", id, error: versionError };
    }

    switch (request.method) {
      case "server/discover": {
        const result = manifestToDiscoverResult(this.manifest);
        result.capabilities.extensions = { ...result.capabilities.extensions, [MCP_TASKS_EXTENSION]: {} };
        return { jsonrpc: "2.0", id, result };
      }

      case "tasks/get":
      case "tasks/cancel":
      case "tasks/update": {
        if (!this.supportsTasks(request)) return this.missingTasksCapability(id);
        const taskId = request.params?.taskId;
        if (typeof taskId !== "string" || !taskId) return this.invalidTask(id);
        const task = request.method === "tasks/cancel"
          ? await this.tasks.cancel(taskId) : await this.tasks.get(taskId);
        if (!task) return this.invalidTask(id);
        if (request.method === "tasks/get") return { jsonrpc: "2.0", id, result: { ...task, resultType: "complete" } };
        if (request.method === "tasks/update") {
          const input = request.params?.inputResponses;
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            return { jsonrpc: "2.0", id, error: { code: RPC_INVALID_PARAMS, message: "tasks/update requires inputResponses" } };
          }
          // Plugin delegates do not emit input requests. Every supplied key is unknown and ignored.
        }
        return { jsonrpc: "2.0", id, result: { resultType: "complete" } };
      }

      case "subscriptions/listen": {
        const notifications = request.params?.notifications as { taskIds?: unknown } | undefined;
        if (!notifications || typeof notifications !== "object" || Array.isArray(notifications)
          || !Array.isArray(notifications.taskIds) || !notifications.taskIds.every((value) => typeof value === "string")) {
          return { jsonrpc: "2.0", id, error: { code: RPC_INVALID_PARAMS, message: "Task subscription requires taskIds" } };
        }
        if (!this.supportsTasks(request)) return this.missingTasksCapability(id);
        if (!notify) return { jsonrpc: "2.0", id, error: { code: RPC_INTERNAL_ERROR, message: "Notification channel unavailable" } };
        const taskIds = new Set(notifications.taskIds as string[]);
        for (const taskId of taskIds) if (!await this.tasks.get(taskId)) return this.invalidTask(id);
        const meta = { "io.modelcontextprotocol/subscriptionId": id };
        this.subscriptions.get(id)?.();
        this.subscriptions.set(id, this.tasks.subscribe((task) => {
          if (taskIds.has(task.taskId)) notify({ jsonrpc: "2.0", method: "notifications/tasks", params: { ...task, _meta: meta } });
        }));
        notify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: { taskIds: [...taskIds] }, _meta: meta } });
        // The subscription request remains open until its transport closes.
        return new Promise(() => {});
      }

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
          const execute = async (): Promise<Record<string, unknown>> => {
            try {
              const outcome = typeof invocation === "string"
                ? await this.callTool(name, args, { invocation }) : await this.callTool(name, args);
              return { resultType: "complete", content: outcome.content,
                ...(outcome.isError !== undefined ? { isError: outcome.isError } : {}),
                ...(outcome._meta !== undefined ? { _meta: outcome._meta } : {}) };
            } catch (err) {
              return { resultType: "complete", content: [{ type: "text", text: errorMessage(err) }], isError: true };
            }
          };
          const operation = execute();
          let result: Record<string, unknown>;
          if (this.supportsTasks(request)) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const pending = Symbol();
            const settled = await Promise.race([operation, new Promise<typeof pending>((resolve) => {
              timer = setTimeout(() => resolve(pending), TOOL_TIMEOUT_POLICY.mcpTaskPromotionMs);
            })]).finally(() => clearTimeout(timer));
            if (settled === pending) {
              const task = await this.tasks.create();
              void operation.then((value) => this.tasks.complete(task.taskId, value))
                .catch(async () => { await this.tasks.fail(task.taskId); })
                .catch((err: unknown) => log.error(`Task persistence failed: ${errorMessage(err)}`));
              return { jsonrpc: "2.0", id, result: { ...task, resultType: "task" } };
            }
            result = settled;
          } else result = await operation;
          return { jsonrpc: "2.0", id, result };
        } catch {
          return { jsonrpc: "2.0", id, error: { code: RPC_INTERNAL_ERROR, message: "Task creation failed" } };
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

  private supportsTasks(request: JsonRpcRequest<JsonRpcId>): boolean {
    const meta = request.params?._meta as Record<string, unknown> | undefined;
    const capabilities = meta?.[META_CLIENT_CAPABILITIES] as { extensions?: Record<string, unknown> } | undefined;
    const extension = capabilities?.extensions?.[MCP_TASKS_EXTENSION];
    return extension !== null && typeof extension === "object" && !Array.isArray(extension);
  }

  private missingTasksCapability(id: JsonRpcId): JsonRpcResponse<JsonRpcId> {
    return { jsonrpc: "2.0", id, error: { code: RPC_MISSING_REQUIRED_CLIENT_CAPABILITY,
      message: "Missing required client capability", data: { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } } } };
  }

  private invalidTask(id: JsonRpcId): JsonRpcResponse<JsonRpcId> {
    return { jsonrpc: "2.0", id, error: { code: RPC_INVALID_PARAMS, message: "Task not found" } };
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
