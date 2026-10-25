/** Keep lexical storage checks child-safe; host filesystem operations separately enforce canonical containment. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PluginStorageError } from "./public-contract.js";

export type PluginStorageRejectionLog = (message: string, meta?: unknown) => void;

/** Inputs must already be absolute and normalized; this predicate checks containment only. */
export function isPathWithin(root: string, target: string): boolean {
  if (target === root) return true;
  // Do not append a second separator to directory or drive roots.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(rootWithSep);
}

/** Resolve raw paths before containment and retain platform casing behavior. */
export function isResolvedPathWithin(root: string, target: string): boolean {
  return isPathWithin(resolve(root), resolve(target));
}

/** The expected host-created data root was replaced by a link or nondirectory. */
export class PluginDataRootError extends Error {
  constructor(readonly owner: string, readonly dataDir: string, readonly found: "symlink" | "non-directory") {
    super(
      found === "symlink"
        ? `${owner}: the plugin data root ${dataDir} is a symlink, not the directory the host created; `
          + "refusing to follow it"
        : `${owner}: the plugin data root ${dataDir} is not a directory`,
    );
    this.name = "PluginDataRootError";
  }
}

/** All root resolution must verify the host-created directory itself before canonicalizing it. */
export function resolvePluginDataRoot(owner: string, dataDir: string): string {
  // Remove trailing separators before lstat so a last-component link cannot be followed.
  const root = resolve(dataDir);
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) throw new PluginDataRootError(owner, root, "symlink");
  if (!entry.isDirectory()) throw new PluginDataRootError(owner, root, "non-directory");
  return realpathSync(root);
}

/** Lexical joining alone is insufficient for filesystem access; follow it with canonical ancestor checks. */
/** Keep audit paths in plugin vocabulary while checking containment on the normalized host path. */
function reportedPath(rel: string): string {
  return rel.split(sep).join("/");
}

export function resolvePluginStoragePath(
  pluginId: string,
  storageRoot: string,
  segments: readonly unknown[],
  log?: PluginStorageRejectionLog,
): string {
  for (const segment of segments) {
    // Validate before join so refusal names the plugin and bad path instead of a bare argument-index TypeError.
    if (typeof segment !== "string") {
      throw new PluginStorageError("path must be a string", pluginId, String(segment));
    }
  }
  const rel = segments.length === 0 ? "." : join(...(segments as string[]));
  if (isAbsolute(rel)) {
    throw new PluginStorageError("absolute paths are not allowed", pluginId, reportedPath(rel));
  }
  const target = resolve(storageRoot, rel);
  if (!isPathWithin(storageRoot, target)) {
    log?.(`storage: rejected escape attempt`, { rel, resolved: target });
    throw new PluginStorageError("path escapes plugin storage root", pluginId, reportedPath(rel));
  }
  return target;
}
