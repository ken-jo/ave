import { sep } from "node:path";
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";

/** Compare drive separators while retaining names and the directory marker. */
export function writeDenyPaths(config: { filesystem: { denyWrite: readonly FilesystemPathEntry[] } }): string[] {
  return config.filesystem.denyWrite.map(entry => {
    const path = typeof entry === "string" ? entry : entry.path;
    return /^[A-Za-z]:[\\/][^:]*$/u.test(path) ? path.replace(/[\\/]/gu, sep) : path;
  });
}
