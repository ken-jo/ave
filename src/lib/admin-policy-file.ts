import { lstat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A failed policy read or stat is absence only when ENOENT is confirmed by
 * inspecting the entry itself. Dangling links and inconclusive probes remain
 * unreadable so each policy reader can apply its own conservative outcome.
 *
 * Windows reports a path through a regular file (`admin/policy.json` with
 * `admin` a file) as ENOENT, where POSIX says ENOTDIR. So a confirmed ENOENT
 * is absence only when the nearest existing ancestor is not a regular file.
 * On POSIX that walk never meets a file — the read would have failed with
 * ENOTDIR — so its outcomes are unchanged, symlinked parent directories
 * included.
 */
export async function isAdminPolicyFileAbsent(
  filePath: string,
  readError: unknown,
  inspectEntry: (path: string) => Promise<unknown> = lstat,
): Promise<boolean> {
  if ((readError as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
  if (!(await isConfirmedMissing(filePath, inspectEntry))) return false;
  for (let ancestor = dirname(filePath); ; ancestor = dirname(ancestor)) {
    let entry: unknown;
    try {
      entry = await inspectEntry(ancestor);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
      if (dirname(ancestor) === ancestor) return true;
      continue;
    }
    const isFile = (entry as { isFile?: unknown } | null | undefined)?.isFile;
    if (typeof isFile !== "function") return false;
    return !isFile.call(entry);
  }
}

async function isConfirmedMissing(path: string, inspectEntry: (path: string) => Promise<unknown>): Promise<boolean> {
  try {
    await inspectEntry(path);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT";
  }
}
