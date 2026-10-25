
import { resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";

export interface PluginPaths {
  /** Absolute path to `registry.json` — sits at the root of `pluginsRoot`. */
  registryPath: string;
  /** Every install source shares <pluginsRoot>/<id>; installSource does not select a different directory. */
  pluginsRoot: string;
  /** Per-plugin rollback version cache. */
  cacheRoot: string;
}

export interface ResolvePluginPathsInput {
  /** Explicit injection overrides aveHome()/plugins; there is no environment override. */
  pluginsRoot?: string;
  cacheRoot?: string;
}

/** Keep registry.json at pluginsRoot so stored manifest paths resolve relative to its directory. */
export function resolvePluginPaths(input: ResolvePluginPathsInput = {}): PluginPaths {
  const pluginsRoot = resolve(
    input.pluginsRoot ?? resolve(aveHome(), "plugins"),
  );
  const cacheRoot = resolve(input.cacheRoot ?? resolve(pluginsRoot, ".cache"));
  return {
    registryPath: resolve(pluginsRoot, "registry.json"),
    pluginsRoot,
    cacheRoot,
  };
}

/** Normalize contained paths to registry-relative POSIX form; trust-root enforcement remains with runtime. */
export function toRegistryRelativeManifestPath(
  registryPath: string,
  manifestPath: string,
): string {
  const registryDir = resolve(registryPath, "..");
  const absolute = resolve(registryDir, manifestPath);
  if (!absolute.startsWith(registryDir + "\\") && !absolute.startsWith(registryDir + "/") && absolute !== registryDir) {
    return absolute.split("\\").join("/");
  }
  const rel = absolute.slice(registryDir.length).replace(/^[\\/]+/, "");
  return rel.split("\\").join("/");
}
