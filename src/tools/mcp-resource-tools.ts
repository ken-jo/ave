// Model resource access shares client capability, listed-URI, fetch, and size gates with user mentions (docs/development/README.md#mcp-resource-consumption-policy).
// Server content is untrusted tool data, never trusted overlay or turn provenance; builtin-name collisions roll back registration.
import { createDynamicTool, toolErrorResult, type Tool } from "./base.js";
import { createLogger } from "../lib/logger.js";
import { scrubShortError } from "../shared/dlp.js";
import { t } from "../i18n/index.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../shared/mcp-resource-bounds.js";
import { MAX_TOOL_RESULT_TOKENS } from "../shared/tool-result-trim.js";
import { estimateTokens } from "../shared/token-estimate.js";
import type { McpResourceSummary } from "../mcp/types.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("ave");

// Match estimateTokens' four-character estimate.
const APPROX_CHARS_PER_TOKEN = 4;

// Cap named server omissions so IDs alone cannot overflow the response budget.
const MAX_NAMED_OMITTED_SERVERS = 20;

// Derive list navigation limits below the result wire cap, with token headroom and a final token-count check.
// Bound both server count and catalogue bytes, reporting every omission.
export const MCP_RESOURCE_LIST_MAX_CHARS = Math.floor(
  MAX_TOOL_RESULT_TOKENS * APPROX_CHARS_PER_TOKEN * 0.9,
);

// Expose only resource access; accepting the full manager would also expose callTool.
export interface McpResourceToolDeps {
  listResources(): Array<{ serverId: string; resources: readonly McpResourceSummary[] }>;
  // Use core readDeclaredResource; UI reads skip listed-URI and resource-capability gates and must remain separate.
  readDeclaredResource(serverId: string, uri: string): Promise<{
    blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
    droppedBlocks: number;
    truncated: boolean;
  }>;
}

// Resolve access per call because manager initialization follows tool registration.
export type McpResourceAccessResolver = () => McpResourceToolDeps | undefined;

export function createMcpResourceListTool(getAccess: McpResourceAccessResolver): Tool {
  return createDynamicTool({
    name: "mcp_resource_list",
    description: t("be_mcpResourceTools.listDescription"),
    source: "builtin",
    // includeMcp controls model exposure for these server-data builtins; execution still requires normal permission gates.
    requiresMcpScope: true,
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        serverId: {
          type: "string",
          description: t("be_mcpResourceTools.serverIdDescription"),
        },
        offset: {
          type: "number",
          description: t("be_mcpResourceTools.offsetDescription"),
        },
      },
    },
    execute: async (rawInput) => {
      const access = getAccess();
      if (!access) return toolErrorResult(t("be_mcpResourceTools.notReady"));
      const a = (rawInput ?? {}) as Record<string, unknown>;
      // Reject unusable serverId instead of silently widening to all servers; list guidance must not request uri.
      if (a.serverId !== undefined && typeof a.serverId !== "string") {
        return toolErrorResult(t("be_mcpResourceTools.invalidServerId"));
      }
      // Source-trimmed resources are absent from result-chunk paging and need a resource offset.
      const offsetRaw = a.offset;
      if (
        offsetRaw !== undefined
        && (typeof offsetRaw !== "number"
          || !Number.isSafeInteger(offsetRaw)
          || offsetRaw < 0)
      ) {
        return toolErrorResult(t("be_mcpResourceTools.invalidOffset"));
      }
      const offset = typeof offsetRaw === "number" ? offsetRaw : 0;
      const wanted = typeof a.serverId === "string" ? a.serverId : undefined;
      // Require serverId for offsets; a shared cross-server cursor would skip catalogue entries.
      if (offset > 0 && wanted === undefined) {
        return toolErrorResult(t("be_mcpResourceTools.offsetNeedsServerId"));
      }
      const servers = access
        .listResources()
        .filter((entry) => (wanted ? entry.serverId === wanted : true))
        .map((entry) => ({
          serverId: entry.serverId,
          resources: entry.resources.slice(offset).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
            ...(resource.size !== undefined ? { size: resource.size } : {}),
            // List refused resources explicitly so callers do not retry impossible reads.
            ...(resource.hostFetchRefused ? { hostFetchRefused: true } : {}),
          })),
        }));
      // Trim descriptions, then resources, then servers; measure each server once to avoid quadratic serialization.
      const budget = MCP_RESOURCE_LIST_MAX_CHARS;
      const serialize = (value: unknown): number => JSON.stringify(value).length;
      let descriptionsOmitted = false;
      if (serialize({ servers }) > budget) {
        descriptionsOmitted = servers.some((server) =>
          server.resources.some((resource) => "description" in resource));
        for (const server of servers) {
          server.resources = server.resources.map((resource) => {
            const { description: _dropped, ...rest } = resource as typeof resource
              & { description?: string };
            return rest as typeof resource;
          });
        }
      }
      const kept: typeof servers = [];
      const omittedServerIds: string[] = [];
      let unnamedOmittedServers = 0;
      let omittedResources = 0;
      let used = 0;
      for (const server of servers) {
        const whole = serialize(server);
        if (used + whole <= budget) {
          kept.push(server);
          used += whole;
          continue;
        }
        // Retain a usable resource prefix when a whole server exceeds the remaining budget.
        const partial = { serverId: server.serverId, resources: [] as typeof server.resources };
        let partialLen = serialize(partial);
        for (const resource of server.resources) {
          const entryLen = serialize(resource) + 1;
          if (used + partialLen + entryLen > budget) {
            omittedResources += 1;
            continue;
          }
          partial.resources.push(resource);
          partialLen += entryLen;
        }
        if (partial.resources.length > 0) {
          kept.push(partial);
          used += partialLen;
        } else {
          // Name omitted servers for narrowing, but charge and cap the ID list within the same budget.
          if (omittedServerIds.length < MAX_NAMED_OMITTED_SERVERS) {
            omittedServerIds.push(server.serverId);
            used += server.serverId.length + 3;
          } else {
            unnamedOmittedServers += 1;
          }
        }
      }
      // Check the serialized envelope, including omissions; narrowed calls report nextOffset whenever entries remain.
      const nextOffset = () => {
        if (wanted === undefined) return undefined;
        const shown = kept.reduce((sum, server) => sum + server.resources.length, 0);
        return offset + shown;
      };
      const payload = () => ({
        servers: kept,
        ...(omittedServerIds.length > 0 ? { omittedServerIds } : {}),
        ...(unnamedOmittedServers > 0 ? { unnamedOmittedServers } : {}),
        ...(omittedResources > 0 ? { omittedResources } : {}),
        ...(descriptionsOmitted ? { descriptionsOmitted: true } : {}),
        ...((omittedResources > 0 || unnamedOmittedServers > 0 || omittedServerIds.length > 0)
          && nextOffset() !== undefined
          ? { nextOffset: nextOffset() }
          : {}),
      });
      // Enforce character and token limits unconditionally; stop trimming if payload size cannot shrink.
      const overBudget = (): boolean => {
        const text = JSON.stringify(payload());
        return text.length > budget || estimateTokens(text) > MAX_TOOL_RESULT_TOKENS;
      };
      while (kept.length > 0 && overBudget()) {
        const before = serialize(payload());
        const last = kept[kept.length - 1];
        // Trim tail resources before dropping their server so a marginal overshoot cannot erase a single-server catalogue.
        if (last.resources.length > 1) {
          last.resources = last.resources.slice(0, -1);
          omittedResources += 1;
        } else {
          kept.pop();
          omittedResources += last.resources.length;
          if (omittedServerIds.length < MAX_NAMED_OMITTED_SERVERS) {
            omittedServerIds.push(last.serverId);
          } else {
            unnamedOmittedServers += 1;
          }
        }
        if (serialize(payload()) >= before) break;
      }
      return { output: JSON.stringify(payload()), isError: false };
    },
  });
}

export function createMcpResourceReadTool(getAccess: McpResourceAccessResolver): Tool {
  return createDynamicTool({
    name: "mcp_resource_read",
    description: t("be_mcpResourceTools.readDescription"),
    source: "builtin",
    // Server content must honor includeMcp restrictions in headless loops.
    requiresMcpScope: true,
    // Resource reads mutate neither files nor trusted prompts; capability approval and listed-URI checks supply authority.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["serverId", "uri"],
      properties: {
        serverId: {
          type: "string",
          description: t("be_mcpResourceTools.serverIdDescription"),
        },
        uri: {
          type: "string",
          description: t("be_mcpResourceTools.uriDescription"),
        },
      },
    },
    execute: async (rawInput) => {
      const access = getAccess();
      if (!access) return toolErrorResult(t("be_mcpResourceTools.notReady"));
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const serverId = typeof a.serverId === "string" ? a.serverId.trim() : "";
      const uri = typeof a.uri === "string" ? a.uri.trim() : "";
      if (serverId.length === 0 || uri.length === 0 || uri.length > MCP_RESOURCE_URI_MAX_CHARS) {
        return toolErrorResult(t("be_mcpResourceTools.invalidRequest"));
      }
      try {
        const read = await access.readDeclaredResource(serverId, uri);
        return {
          output: JSON.stringify({
            uri,
            serverId,
            blocks: read.blocks,
            ...(read.truncated ? { truncated: true } : {}),
            ...(read.droppedBlocks > 0 ? { droppedBlocks: read.droppedBlocks } : {}),
          }),
          isError: false,
        };
      } catch (err) {
        // Return stable public failures to prevent host-path disclosure and probing; log the real cause only after secret scrubbing.
        // Bound attacker-controlled server errors and IDs to preserve forensic logs and keep credentials off disk.
        log.warn(
          `mcp_resource_read failed server=${serverId.slice(0, 64)} `
            + `uri=${uri.slice(0, 256)}: `
            + scrubShortError(errorMessage(err)),
        );
        return toolErrorResult(t("be_mcpResourceTools.readFailed"));
      }
    },
  });
}
