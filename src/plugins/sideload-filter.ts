import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isPluginRuntimeDirName } from "./plugin-storage-layout.js";

/** Exclude bundled runtime archives and bin shims so recursive copy neither parses archives nor leaves dangling launchers. */
export function buildSideloadCopyFilter(sourceRoot: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = relative(sourceRoot, src);
    if (!rel) return true;
    const parts = rel.split(/[\\/]/);
    // Refuse top-level runtime state rather than silently discard it or collide with live state.
    if (parts.length === 1 && isPluginRuntimeDirName(parts[0]!)) {
      throw new Error(
        `[installLocal] plugin source may not contain a top-level runtime directory: ${rel}`,
      );
    }
    if (parts[0] === ".git") return false;
    const nmIdx = parts.indexOf("node_modules");
    if (nmIdx >= 0) {
      const next = parts[nmIdx + 1];
      if (next === "electron" || next === "@electron" || next === ".bin") return false;
    }
    return true;
  };
}

/** Reject all staged symlinks before promotion so invalid copies never replace live bytes. */
export async function rejectSideloadSymlinks(dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new Error(`rejectSideloadSymlinks: dir must be absolute, got: ${dir}`);
  await walkForSideloadSymlinks(dir, dir);
}

async function walkForSideloadSymlinks(current: string, root: string): Promise<void> {
  // Propagate every walk error; skipped unreadable directories would leave link validation incomplete.
  const entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `[installLocal] symbolic link is not allowed in install dir: ${relative(root, full)}`,
      );
    } else if (entry.isDirectory()) {
      await walkForSideloadSymlinks(full, root);
    }
  }
}
