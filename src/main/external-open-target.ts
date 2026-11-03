// One default-app open sequence for every host channel that hands a file to the OS (attach.openExternal, workspace.openPath).
import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { DENY_EXTENSIONS as DENY_LIST } from "../shared/attachments-deny-list.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../permissions/sensitive-paths.js";

const DENY_EXTENSIONS = new Set<string>(DENY_LIST);

/** Refusals this sequence itself produces; callers add their own authority codes. */
export type ExternalOpenRefusal = "not-found" | "sensitive-path" | "denied_extension" | "not-a-file" | "changed" | "open-failed";

/** Lowercase extension of a path's last segment, or "" when it has none. */
export function externalOpenExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True when the picker deny list (executables, installers, scripts) names this path's extension. */
export function isDeniedExternalOpenExtension(path: string): boolean {
  return DENY_EXTENSIONS.has(externalOpenExtension(path));
}

function sensitiveForRead(path: string): boolean {
  return isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(path)), "read") !== null;
}

/** Re-resolve a requested spelling on every use, since a link may have been retargeted since it was authorized. */
export async function resolveExternalOpenTarget(
  requested: string,
): Promise<{ ok: true; real: string } | { ok: false; error: ExternalOpenRefusal }> {
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (sensitiveForRead(real)) return { ok: false, error: "sensitive-path" };
  if (isDeniedExternalOpenExtension(real)) return { ok: false, error: "denied_extension" };
  return { ok: true, real };
}

/**
 * Hand one regular file to the OS default app. `authorize` is the caller's authority check (sender, picker allowlist, preview
 * receipt, project containment); it runs on the first resolution and again on a fresh resolution immediately before the open,
 * so the deny list, the sensitive floor and the caller's containment all judge the exact target that is opened.
 */
export async function openVerifiedExternalFile<A extends string>(
  requested: string,
  authorize: (real: string) => A | null,
): Promise<{ ok: true; real: string } | { ok: false; error: ExternalOpenRefusal | A }> {
  // The requested spelling and its target are both judged: `notes.sh -> notes.txt` and `notes.txt -> run.sh` are both refused.
  if (isDeniedExternalOpenExtension(requested)) return { ok: false, error: "denied_extension" };
  const target = await resolveExternalOpenTarget(requested);
  if (!target.ok) return target;
  const first = authorize(target.real);
  if (first !== null) return { ok: false, error: first };
  let isFile: boolean;
  try {
    isFile = (await fs.stat(target.real)).isFile();
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!isFile) return { ok: false, error: "not-a-file" };
  const current = await resolveExternalOpenTarget(requested);
  if (!current.ok) return current;
  const last = authorize(current.real);
  if (last !== null) return { ok: false, error: last };
  if (current.real !== target.real) return { ok: false, error: "changed" };
  const failure = await shell.openPath(current.real);
  return failure ? { ok: false, error: "open-failed" } : { ok: true, real: current.real };
}
