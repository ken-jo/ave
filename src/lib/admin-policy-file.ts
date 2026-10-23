import { lstat, stat } from "node:fs/promises";
import { dirname } from "node:path";

async function hasDirectoryAncestor(filePath: string): Promise<boolean> {
  let parent = dirname(filePath);
  for (;;) {
    try {
      const entry = await lstat(parent);
      if (entry.isSymbolicLink()) {
        try {
          return (await stat(parent)).isDirectory();
        } catch {
          return false;
        }
      }
      return entry.isDirectory();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
    }
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
}

/**
 * A failed policy read or stat is absence only when ENOENT is confirmed by
 * inspecting the entry and its missing ancestors. Dangling links and inconclusive
 * probes remain unreadable so each reader can apply its own conservative outcome.
 */
export async function isAdminPolicyFileAbsent(
  filePath: string,
  readError: unknown,
  inspectEntry: (path: string) => Promise<unknown> = lstat,
): Promise<boolean> {
  if ((readError as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
  try {
    await inspectEntry(filePath);
    return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
    // The host can report ENOENT rather than ENOTDIR for a non-directory parent.
    return await hasDirectoryAncestor(filePath);
  }
}
