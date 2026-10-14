/**
 * Where an agent plugin package keeps its data, and the package-name grammar
 * that keys it. The bundled MCP servers and hooks of one package share a
 * directory under the `agent-plugin-data` feature namespace, and uninstall
 * removes exactly that directory, so the runtimes and the remover must agree
 * on both the name rule and the location.
 */
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";

const AGENT_PLUGIN_PACKAGE_NAME = /^[a-z][a-z0-9-]*$/u;

/** Feature namespace holding one data directory per agent plugin package. */
export const AGENT_PLUGIN_DATA_NAMESPACE = "agent-plugin-data";

/** Refuse a package name that could escape or alias the data directory. */
export function assertAgentPluginPackageName(name: string): void {
  if (!AGENT_PLUGIN_PACKAGE_NAME.test(name)) throw new Error(`invalid agent plugin package name ${name}`);
}

/** The package's data directory, or the caller's override for it. */
export function agentPluginDataDir(
  name: string,
  override?: (name: string) => Promise<string>,
): Promise<string> {
  assertAgentPluginPackageName(name);
  return override?.(name) ?? openFeatureNamespace(AGENT_PLUGIN_DATA_NAMESPACE).childDir(name);
}
