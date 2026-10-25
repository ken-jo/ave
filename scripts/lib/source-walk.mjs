// Shared walkers must be import-safe; importing a gate would also execute its scan.
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * List every regular file under `dir`, depth first, in directory order.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {ReadonlySet<string>} [options.skipDirs] directory NAMES (not paths)
 *   that are not descended into, at any depth.
 * @param {readonly string[]} [options.extensions] keep only files whose name
 *   ends with one of these (write the dot: `".ts"`). Omit to keep every file.
 * @param {(path: string) => boolean} [options.accept] final per-file filter.
 * @param {boolean} [options.tolerateUnreadableDirs] `true` treats a directory
 *   that cannot be listed (absent, unreadable) as empty instead of throwing.
 * @param {string[]} [out] internal — passed only by the recursion, which is
 *   also how a nested call is told apart from the caller's own.
 * @returns {string[]} absolute paths when `dir` is absolute.
 */
export function walkSourceFiles(dir, options = {}, out) {
  const isRoot = out === undefined;
  const found = out ?? [];
  const {
    skipDirs = new Set(),
    extensions,
    accept,
    tolerateUnreadableDirs = false,
  } = options;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Ignore nested directories removed concurrently; a missing root still fails unless explicitly tolerated.
    if (!isRoot && error?.code === "ENOENT") return found;
    if (tolerateUnreadableDirs) return found;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkSourceFiles(path, options, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }
    if (accept && !accept(path)) continue;
    found.push(path);
  }
  return found;
}
