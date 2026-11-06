/** Keep loading, method projection and import URL derivation shared while callers own audit and failure handling. */
import type {
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { isAppVisible } from "./tool-visibility.js";
import { pathToFileURL } from "node:url";

/** App-visible methods are the normalized app-only and dual tool union. */
export function declaredAppVisibleToolMethods(
  manifest: Pick<PluginManifest, "tools">,
): string[] {
  return (manifest.tools ?? []).filter(isAppVisible).map((t) => t.name);
}

/** Runtime methods include the full model/app union; defensively deduplicate names. */
/** All instantiation paths derive methods through buildMethodMap. */
function declaredRuntimeMethods(manifest: Pick<PluginManifest, "tools">,
): string[] {
  return [...new Set((manifest.tools ?? []).map((t) => t.name))];
}

/** Keep entry URL construction beside module import so cache-busting has one owner. */
export function buildImportUrl(entryPath: string, bustCache = false): string {
  const url = pathToFileURL(entryPath).href;
  return bustCache ? `${url}?reload=${Date.now()}` : url;
}

/** Only the child imports production plugin modules; prefer default factory, then createPlugin. */
export async function importPluginFactory(
  resolvedEntryPath: string,
  bustCache?: boolean,
): Promise<RuntimePluginFactory | undefined> {
  const module = (await import(buildImportUrl(resolvedEntryPath, bustCache))) as {
    default?: RuntimePluginFactory;
    createPlugin?: RuntimePluginFactory;
  };
  return module.default ?? module.createPlugin;
}

/** Skip missing declared handlers and report each through the caller diagnostic callback. */
export function buildMethodMap(
  manifest: Pick<PluginManifest, "tools">,
  instance: RuntimePlugin,
  onMissingHandler: (toolName: string) => void,
): Map<string, PluginToolHandler> {
  const methods = new Map<string, PluginToolHandler>();
  for (const toolName of declaredRuntimeMethods(manifest)) {
    const handler = instance.handlers[toolName];
    if (!handler) {
      onMissingHandler(toolName);
      continue;
    }
    methods.set(toolName, handler);
  }
  return methods;
}
