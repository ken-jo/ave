/** Hooks, MCP runtimes and uninstall share the same package-scoped data directory and name rules. */
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";

const AGENT_PLUGIN_PACKAGE_NAME = /^[a-z][a-z0-9-]*$/u;

const AGENT_PLUGIN_DATA_NAMESPACE = "agent-plugin-data";

export function agentPluginDataRoot(): string {
  return openFeatureNamespace(AGENT_PLUGIN_DATA_NAMESPACE).dir;
}

/** Refuse a package name that could escape or alias the data directory. */
export function assertAgentPluginPackageName(name: string): void {
  if (!AGENT_PLUGIN_PACKAGE_NAME.test(name)) throw new Error(`invalid agent plugin package name ${name}`);
}

export function agentPluginDataDir(
  name: string,
  override?: (name: string) => Promise<string>,
): Promise<string> {
  assertAgentPluginPackageName(name);
  return override?.(name) ?? openFeatureNamespace(AGENT_PLUGIN_DATA_NAMESPACE).childDir(name);
}
