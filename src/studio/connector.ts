import { sha256Hex } from "../lib/hex-digest-equal.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { StaticBundledMcpServer, BundledMcpAuth } from "../mcp/portable-mcp.js";
import type { StudioConnectorCopyPreview } from "../shared/plugin-studio.js";
import { studioConnectorWarning } from "./lint.js";
import { studioConnectorSpecDigest } from "./connector-digest.js";

export async function previewStudioConnector(manager: McpManager, serverId: string): Promise<StudioConnectorCopyPreview> {
  const { spec, args, env } = await manager.getStudioConnectorSource(serverId);
  const specDigest = studioConnectorSpecDigest(spec, args, env);
  return {
    serverId, spec, specDigest,
    args: args.map((value, index) => ({ index, value, digest: sha256Hex(`${index}\0${value}`),
      ...(studioConnectorWarning(value) ? { warning: studioConnectorWarning(value) } : {}) })),
    env: Object.entries(env).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({
      name, value, digest: sha256Hex(`${name}\0${value}`),
      ...(studioConnectorWarning(value) ? { warning: studioConnectorWarning(value) } : {}),
    })),
  };
}

export function verifyStudioConnectorPreview(preview: StudioConnectorCopyPreview): void {
  const args = preview.args.map((item, index) => {
    if (item.index !== index || item.digest !== sha256Hex(`${index}\0${item.value}`)) {
      throw new Error("Connector argument preview is invalid");
    }
    return item.value;
  });
  const env: Record<string, string> = {};
  for (const item of preview.env) {
    if (Object.hasOwn(env, item.name) || item.digest !== sha256Hex(`${item.name}\0${item.value}`)) {
      throw new Error("Connector environment preview is invalid");
    }
    env[item.name] = item.value;
  }
  if (studioConnectorSpecDigest(preview.spec, args, env) !== preview.specDigest) {
    throw new Error("Connector preview digest is invalid");
  }
}

export function portableStudioConnector(preview: StudioConnectorCopyPreview): {
  server: StaticBundledMcpServer;
  auth?: BundledMcpAuth[string];
} {
  const spec = preview.spec;
  if (spec.auth && spec.auth !== "none" && spec.auth !== "api-key") {
    throw new Error(`Connector ${preview.serverId} authentication is not portable`);
  }
  if (spec.transport === "stdio") {
    if (spec.command.startsWith("./") || preview.args.some((item) =>
      item.value.startsWith("./") || item.value.includes("${PLUGIN_ROOT}") || item.value.includes("${PLUGIN_DATA}"))) {
      throw new Error(`Connector ${preview.serverId} refers to package-local files Studio cannot copy`);
    }
    const auth = spec.auth === "api-key"
      ? (() => {
        if (!spec.apiKeyEnv) throw new Error(`Connector ${preview.serverId} needs an API key environment name`);
        return { auth: "api-key" as const, apiKeyEnv: spec.apiKeyEnv };
      })() : undefined;
    return { server: { transport: "stdio", command: spec.command,
      args: preview.args.map((item) => item.value),
      env: Object.fromEntries(preview.env.map((item) => [item.name, item.value])), cwd: "${PLUGIN_ROOT}",
      ...(auth ? { auth: "api-key", apiKeyEnv: auth.apiKeyEnv } : {}) }, ...(auth ? { auth } : {}) };
  }
  if (spec.transport === "http") {
    const auth = spec.auth === "api-key"
      ? (() => {
        if (!spec.apiKeyHeader) throw new Error(`Connector ${preview.serverId} needs an API key header name`);
        return { auth: "api-key" as const, apiKeyHeader: spec.apiKeyHeader };
      })() : undefined;
    return { server: { transport: "http", url: spec.url,
      ...(auth ? { auth: "api-key", apiKeyHeader: auth.apiKeyHeader } : {}) }, ...(auth ? { auth } : {}) };
  }
  throw new Error(`Connector ${preview.serverId} transport is not portable`);
}
