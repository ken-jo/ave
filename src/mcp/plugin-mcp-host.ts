/** Plugin hosts use stateless discovery and natural tool names with plugin authority.
 * Transport injection permits loopback or stdio without external-server negotiation branches. */
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from "./mcp-client.js";
import { LoopbackTransport } from "./loopback-transport.js";
import { PluginMcpServer, type PluginToolDelegate } from "./plugin-mcp-server.js";
import type { PluginUiResourceProvider } from "./plugin-ui-resource-provider.js";
import { mcpToolToPluginTool, type DiscoveredMcpTool } from "./plugin-tool-from-mcp.js";
import { lintToolInputSchema } from "../plugins/tool-schema-lint.js";
import { createLogger } from "../lib/logger.js";
import type { Tool } from "../tools/base.js";
import type { PluginManifest } from "../plugins/types.js";
import type { PluginToolOperationPolicy } from "../tools/plugin-operation-governance.js";
import type { McpToolCallOutput, McpUiPayload, McpUiResourceMeta, McpUiResourceRead } from "./types.js";
import { renderMcpContent } from "./mcp-tool-content.js";
import { canonicalStringify } from "../shared/canonical-json.js";

const log = createLogger("plugin-mcp-host");

import {
  MCP_PROTOCOL_VERSION,
  META_PROTOCOL_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPABILITIES,
  RAW_RESULT_META,
} from "./protocol-constants.js";

import { getAveAppVersion } from "../shared/app-version.js";

const CLIENT_INFO = { name: "ave", version: getAveAppVersion() } as const;
const CLIENT_CAPABILITIES = { elicitation: { form: {}, url: {} }, extensions: {} } as const;

interface RcToolCallResult {
  resultType?: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: {
    ui?: {
      resourceUri?: string;
      slot?: string;
      height?: number;
      title?: string;
      // CSP belongs to the resource, never the tool result.
    };
    [key: string]: unknown;
  };
}


export class PluginMcpHost {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private started = false;

  constructor(
    private readonly pluginId: string,
    private readonly transport: McpTransport,
    private readonly signedOperationPolicies: Record<string, PluginToolOperationPolicy> = {},
    private readonly generationId: string,
  ) {
    if (typeof generationId !== "string" || generationId.trim().length === 0) {
      throw new Error(`[plugin-mcp-host] immutable generation id is required for '${pluginId}'`);
    }
  }

  static loopback(
    manifest: PluginManifest,
    delegate: PluginToolDelegate,
    uiResources: PluginUiResourceProvider | undefined,
    generationId: string,
  ): PluginMcpHost {
    const server = new PluginMcpServer(manifest, delegate, uiResources);
    return new PluginMcpHost(
      manifest.id,
      new LoopbackTransport(server),
      Object.fromEntries(
        manifest.tools.flatMap((tool) => {
          const policy = tool._meta?.["ave/operationPolicy"];
          return policy ? [[tool.name, policy] as const] : [];
        }),
      ),
      generationId,
    );
  }

  async prepareTools(): Promise<readonly Tool[]> {
    if (this.started) {
      throw new Error(`[plugin-mcp-host] '${this.pluginId}' already started`);
    }
    return Object.freeze(await this.buildTools());
  }

  publishPrepared(_tools: readonly Tool[]): void {
    this.started = true;
  }

  /** Build without touching live registration; failure closes only this candidate transport. */
  private async buildTools(): Promise<Tool[]> {
    this.transport.onMessage((msg) => this.handleResponse(msg));
    this.transport.onClose((reason) => this.failAllPending(reason));
    await this.transport.open();
    try {
      const discover = (await this.request("server/discover", {})) as {
        supportedVersions?: string[];
      };
      if (!discover.supportedVersions?.includes(MCP_PROTOCOL_VERSION)) {
        throw new Error(
          `[plugin-mcp-host] plugin '${this.pluginId}' did not advertise RC protocol ${MCP_PROTOCOL_VERSION} ` +
            `(got ${JSON.stringify(discover.supportedVersions)}); first-party plugins are RC-only.`,
        );
      }

      const list = (await this.request("tools/list", {})) as { tools?: DiscoveredMcpTool[] };
      const tools: Tool[] = [];
      for (const tool of list.tools ?? []) {
        const signedPolicy = this.signedOperationPolicies[tool.name];
        const wirePolicy = tool._meta?.["ave/operationPolicy"];
        if (
          canonicalStringify(wirePolicy ?? null) !==
          canonicalStringify(signedPolicy ?? null)
        ) {
          throw new Error(
            `[plugin-mcp-host] plugin '${this.pluginId}' tool '${tool.name}' operation policy differs from its signed manifest`,
          );
        }
        // Structural protocol failures abort the build; tool risk uses the strict host-derived baseline.
        const registryTool = mcpToolToPluginTool(
          this.pluginId,
          tool,
          (name, args) => this.invoke(name, args),
          signedPolicy,
          this.generationId,
        );

        // Drop individually invalid provider schemas so one tool cannot break every turn.
        const violations = lintToolInputSchema(tool.inputSchema);
        if (violations.length > 0) {
          log.warn(
            `plugin '${this.pluginId}' tool '${tool.name}' dropped — inputSchema fails LLM provider-strict lint: ${violations
              .map((v) => v.rule)
              .join(", ")}`,
          );
          continue;
        }
        tools.push(registryTool);
      }
      return tools;
    } catch (err) {
      // Candidate failure must preserve the previous registration and close only this transport.
      await this.transport.close();
      throw err;
    }
  }

  /** Superseded hosts close transport only; unregistering would remove the newly published tools. */
  async dispose(): Promise<void> {
    if (!this.started) {
      await this.transport.close();
      return;
    }
    this.started = false;
    await this.transport.close();
  }

  private async invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallOutput & { rawResult?: { value: unknown } }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as RcToolCallResult;

    // Unsupported result branches fail with a typed error rather than silently degrade.
    if (result.resultType === "input_required") {
      throw new Error(
        `[plugin-mcp-host] tool '${name}' on '${this.pluginId}' returned resultType="input_required" — the MRTR input loop is not implemented yet (milestone mrtr-input-loop)`,
      );
    }
    if (result.resultType === "task") {
      throw new Error(
        `[plugin-mcp-host] tool '${name}' on '${this.pluginId}' returned resultType="task" — the Tasks extension is not implemented yet (milestone tasks-extension)`,
      );
    }
    if (result.isError) {
      throw new Error(renderMcpContent(result.content).text);
    }

    const { text, images } = renderMcpContent(result.content);
    const uiMeta = result._meta?.ui;
    const uiPayload: McpUiPayload | undefined = uiMeta?.resourceUri
      ? {
          serverId: this.pluginId,
          generationId: this.generationId,
          resourceUri: uiMeta.resourceUri,
          slot: (uiMeta.slot as McpUiPayload["slot"]) ?? "chat",
          height: uiMeta.height,
          title: uiMeta.title,
        }
      : undefined;
    // Box raw results to preserve present-but-undefined values; read only the owned metadata key.
    const meta = result._meta;
    let rawResult: { value: unknown } | undefined;
    if (meta && Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)) {
      rawResult = { value: meta[RAW_RESULT_META] };
    } else {
      rawResult = undefined;
    }
    return { text, uiPayload, rawResult, ...(images.length > 0 ? { images } : {}) };
  }

  /** UI reads return resource-owned policy and reject undeclared or cross-namespace URIs. */
  async readUiResource(uri: string): Promise<McpUiResourceRead> {
    const result = (await this.request("resources/read", { uri })) as {
      contents?: Array<{ text?: string; _meta?: { ui?: McpUiResourceMeta } }>;
    };
    const textPart = result.contents?.find((c) => typeof c.text === "string");
    if (!textPart?.text) {
      throw new Error(
        `[plugin-mcp-host] resource '${uri}' on '${this.pluginId}' returned no text content`,
      );
    }
    const ui = textPart._meta?.ui;
    return { html: textPart.text, csp: ui?.csp, permissions: ui?.permissions };
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: this.withRequestMeta(params),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(request).catch((err: unknown) => {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private withRequestMeta(params: Record<string, unknown>): Record<string, unknown> {
    return {
      ...params,
      _meta: {
        [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: CLIENT_INFO,
        [META_CLIENT_CAPABILITIES]: CLIENT_CAPABILITIES,
      },
    };
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  private failAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error(`[plugin-mcp-host] '${this.pluginId}' transport closed: ${reason}`));
    }
    this.pending.clear();
  }
}
