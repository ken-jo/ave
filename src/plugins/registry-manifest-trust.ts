/** Resolve registry paths and prove canonical containment in one authority so unresolved relative paths cannot bypass trust. */

import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Use path.relative containment, rejecting parent segments and absolute results. */
function isPathContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  if (rel === "" || rel === ".") return false;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/** Require canonical containment after symlink resolution, not just lexical prefix matching. */
export function resolveTrustedRegistryManifestPath(
  rawManifestPath: string,
  pluginsRoot: string,
): string | null {
  const absolute = isAbsolute(rawManifestPath)
    ? rawManifestPath
    : resolve(pluginsRoot, rawManifestPath);
  let canonicalManifest: string;
  let canonicalRoot: string;
  try {
    canonicalManifest = realpathSync(absolute);
    canonicalRoot = realpathSync(pluginsRoot);
  } catch {
    return null;
  }
  return isPathContained(canonicalRoot, canonicalManifest) ? absolute : null;
}

/** Prefer the resolving form so callers cannot accidentally check an unresolved relative path. */
export function isTrustedRegistryManifestPath(
  manifestPath: string,
  pluginsRoot: string,
): boolean {
  return resolveTrustedRegistryManifestPath(manifestPath, pluginsRoot) !== null;
}
