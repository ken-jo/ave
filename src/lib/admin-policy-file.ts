import { lstat } from "node:fs/promises";

/**
 * A failed policy read or stat is absence only when ENOENT is confirmed by
 * inspecting the entry itself. Dangling links and inconclusive probes remain
 * unreadable so each policy reader can apply its own conservative outcome.
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
    return (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT";
  }
}
