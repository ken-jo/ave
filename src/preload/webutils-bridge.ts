// Drop-path resolution bridge (webUtils.getPathForFile).
//
// Electron ≥32 removed `File.prototype.path`, so a dropped `File` no longer
// carries its filesystem path. The documented replacement,
// `webUtils.getPathForFile(file)`, MUST be called in a context that holds the
// real `File` instance — and a `File` cannot be structured-cloned across IPC,
// so it can never reach the main process. The preload is therefore the ONLY
// place the drop path can be resolved.
//
// TRUST BOUNDARY: the string this returns is a renderer-NAMED path — it grants
// no capability on its own. The read-scope widening decision is made entirely
// by the main-process `workspace.dropPrepare` gate (Layer-0 hard-deny +
// is-a-directory check + main-owned ack token) and the explicit user ack; this
// bridge only turns a dropped `File` into a candidate path for that gate to
// validate. Its surface is deliberately narrow: it exposes a single
// drop-resolution helper, never raw `webUtils`.
//
// COMPOSER FILE DROP: `prepareFileDrop` is different in kind. It resolves the
// paths AND sends them to main in one preload-internal step, so the main world
// never holds a path string it could substitute. A `File` that is not OS-backed
// (constructed in script, blob-backed) resolves to "" and is never sent, so the
// only paths that can reach `attach.registerDrop` are files the user actually
// dropped or picked. Main answers with a one-shot token the renderer redeems.
import { ipcRenderer, webUtils } from "electron";
import { CHANNELS } from "../contract/app-contract.js";

/**
 * Resolve the filesystem paths of dropped files. `webUtils.getPathForFile`
 * returns `""` for a `File` with no OS-backed path — a non-file drag (text/URL)
 * or a synthetic/blob-backed file (electron#44600). That empty string is
 * filtered EXPLICITLY here so it can never flow downstream to
 * `workspace.dropPrepare` (where it would otherwise read as an `invalid-path`
 * rejection): the result contains only real, non-empty candidate paths in drop
 * order.
 */
export function resolveDroppedPaths(files: FileList | readonly File[]): string[] {
  const out: string[] = [];
  for (const file of Array.from(files)) {
    const resolved = webUtils.getPathForFile(file);
    // Explicit empty-string guard — an unresolved path is never forwarded.
    if (resolved) out.push(resolved);
  }
  return out;
}

/**
 * Register dropped files with main and return its one-shot token.
 *
 * Accepts only `File` objects: the paths are resolved here, never taken from
 * the caller. An empty resolution (no OS-backed file) answers without an IPC.
 */
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
