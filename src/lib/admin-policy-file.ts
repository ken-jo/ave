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

/** Only confirmed absence counts as missing policy; dangling links and inconclusive probes remain unreadable. */
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
    // ENOENT can also mean a non-directory parent.
    return await hasDirectoryAncestor(filePath);
  }
}
