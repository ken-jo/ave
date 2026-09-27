import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentPluginComponents } from "../marketplace/catalog/types.js";
import { isResolvedPathWithin } from "../plugins/plugin-storage-containment.js";
import { resolveBundledArgv } from "../plugins/resolve-bundled-argv.js";
import { portableLauncherLiteralIndexes } from "./portable-launcher.js";
import { prepareBundledMcpProjection, type PreparedPluginMcpProjection } from "./plugin-mcp-projection.js";

export interface AgentPluginMcpActivation {
  packageName: string;
  version: string;
  generationRoot: string;
  dataDir: string;
  activationId: string;
  generationId: string;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;

function containedReference(value: string, root: string, label: string): string {
  const suffix = value.startsWith("./") ? value.slice(2)
    : value.startsWith("${PLUGIN_ROOT}/") ? value.slice("${PLUGIN_ROOT}/".length)
      : value.startsWith("${PLUGIN_DATA}/") ? value.slice("${PLUGIN_DATA}/".length) : "";
  if (suffix && (isAbsolute(suffix) || /^[A-Za-z]:/u.test(suffix) || suffix.includes("\\") || CONTROL.test(suffix)
    || suffix.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error(`${label} leaves its declared root`);
  }
  const realRoot = realpathSync(root);
  const candidate = suffix ? resolve(realRoot, suffix) : realRoot;
  if (!isResolvedPathWithin(realRoot, candidate)) throw new Error(`${label} leaves its declared root`);
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = resolve(existing, "..");
    if (parent === existing) throw new Error(`${label} leaves its declared root`);
    existing = parent;
  }
  if (!isResolvedPathWithin(realRoot, realpathSync(existing))) throw new Error(`${label} follows a symlink outside its root`);
  return candidate;
}

function resolveValue(value: string, activation: AgentPluginMcpActivation, label: string, directory: boolean): string {
  let resolved: string;
  if (value === "${PLUGIN_ROOT}") resolved = containedReference(value, activation.generationRoot, label);
  else if (value === "${PLUGIN_DATA}") resolved = containedReference(value, activation.dataDir, label);
  else if (value.startsWith("${PLUGIN_ROOT}/") || value.startsWith("./")) resolved = containedReference(value, activation.generationRoot, label);
  else if (value.startsWith("${PLUGIN_DATA}/")) resolved = containedReference(value, activation.dataDir, label);
  else if (!directory && !value.includes("${") && !CONTROL.test(value)) return value;
  else throw new Error(`${label} is not a declared package or data path`);
  if (directory && (!existsSync(resolved) || !statSync(resolved).isDirectory())) throw new Error(`${label} is not a directory`);
  return resolved;
}

/** Turn sealed, symbolic descriptor authority into runtime-only server approvals. */
export function resolveRuntimeMcp(
  staticServers: AgentPluginComponents["mcpServers"],
  activation: AgentPluginMcpActivation,
): readonly PreparedPluginMcpProjection[] {
  const projections: PreparedPluginMcpProjection[] = [];
  for (const [localId, server] of Object.entries(staticServers)) {
    const owner = {
      pluginId: `agent-plugin/${activation.packageName}`,
      pluginVersion: activation.version,
      activationId: activation.activationId,
      generationId: activation.generationId,
      localId,
      fingerprint: server.digest,
    };
    if (server.transport === "http") {
      const { digest: _digest, ...config } = server;
      projections.push(prepareBundledMcpProjection(owner, config));
      continue;
    }
    const label = `agent plugin ${activation.packageName} MCP ${localId}`;
    const argv = [server.command, ...(server.args ?? [])];
    const resolved = resolveBundledArgv({
      generationRoot: activation.generationRoot,
      dataDir: activation.dataDir,
      argv,
      baseFingerprint: server.digest,
      label,
      policy: "mcp",
      launcherLiteralIndexes: portableLauncherLiteralIndexes(localId, server.command, server.args ?? []),
    });
    const env = Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) =>
      [key, resolveValue(value, activation, `${label}.env.${key}`, false)]));
    const { digest: _digest, ...staticConfig } = server;
    const config = {
      ...staticConfig,
      command: resolved.argv[0],
      args: resolved.argv.slice(1),
      cwd: resolveValue(server.cwd, activation, `${label}.cwd`, true),
      env: { ...env, PLUGIN_ROOT: realpathSync(activation.generationRoot), PLUGIN_DATA: realpathSync(activation.dataDir) },
    };
    projections.push(prepareBundledMcpProjection({ ...owner, fingerprint: resolved.fingerprint }, config, realpathSync(activation.dataDir)));
  }
  return Object.freeze(projections);
}
