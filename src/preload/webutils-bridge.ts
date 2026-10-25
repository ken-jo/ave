// Resolve real File paths in preload because IPC cannot carry them; candidate paths grant no authority without main validation and user acknowledgment.
import { ipcRenderer, webUtils } from "electron";
import { CHANNELS } from "../contract/app-contract.js";

/** Filter non-backed or synthetic files' empty paths before main validation, preserving drop order. */
export function resolveDroppedPaths(files: FileList | readonly File[]): string[] {
  const out: string[] = [];
  for (const file of Array.from(files)) {
    const resolved = webUtils.getPathForFile(file);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Resolve File objects and register paths atomically in preload; empty drops perform no IPC and main returns a one-shot token. */
export async function prepareFileDrop(
  files: FileList | readonly File[],
): Promise<
  | { ok: true; token: string; rejected: Array<{ name: string; reason: string }> }
  | { ok: false; error: string; rejected?: Array<{ name: string; reason: string }> }
> {
  const paths = resolveDroppedPaths(files);
  if (paths.length === 0) return { ok: false, error: "nothing-attachable" };
  return ipcRenderer.invoke(CHANNELS.attach.registerDrop, paths);
}
