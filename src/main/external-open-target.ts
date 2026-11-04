// One default-app open sequence for every host channel that hands a file to the OS (attach.openExternal, workspace.openPath).
import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { DENY_EXTENSIONS as DENY_LIST } from "../shared/attachments-deny-list.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../permissions/sensitive-paths.js";

const DENY_EXTENSIONS = new Set<string>(DENY_LIST);

/**
 * Formats that run code, or point somewhere else, when the OS default app "opens" them. Open-only: attaching a .js or .jar to
 * a chat stays allowed, so the shared picker list does not grow. A shortcut or link file (.lnk, .url, .webloc, .fileloc) is
 * refused because its target escapes the realpath containment the caller checked.
 */
const OPEN_DENY_EXTENSIONS = new Set<string>([
  // macOS
  "command", "terminal", "tool", "webloc", "fileloc", "workflow", "scpt", "applescript", "action",
  // Windows
  "lnk", "url", "js", "jse", "vbe", "wsf", "wsh", "hta", "pif", "cpl", "reg", "scf", "appref-ms", "settingcontent-ms",
  "msc", "ps1xml", "psm1", "psd1", "inf", "application", "msp", "msix", "appx", "gadget",
  // Both
  "jar",
]);

/** Refusals this sequence itself produces; callers add their own authority codes. */
export type ExternalOpenRefusal = "not-found" | "sensitive-path" | "denied_extension" | "executable" | "not-a-file" | "changed" | "open-failed";

/** Which pass of the sequence the caller's authority check is judging. */
export type ExternalOpenPass = "first" | "final";

/** Lowercase extension of a path's last segment, or "" when it has none. */
function externalOpenExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True when the picker deny list (executables, installers, scripts) names this path's extension. */
function isDeniedExternalOpenExtension(path: string): boolean {
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

function isOpenDenied(path: string): boolean {
  const extension = externalOpenExtension(path);
  return DENY_EXTENSIONS.has(extension) || OPEN_DENY_EXTENSIONS.has(extension);
}

/** Resolve, apply the open-only deny list to both names, and require a regular file that is not marked executable. */
async function judgeOpenTarget(requested: string): Promise<{ ok: true; real: string } | { ok: false; error: ExternalOpenRefusal }> {
  // The requested spelling and its target are both judged: `notes.sh -> notes.txt` and `notes.txt -> run.sh` are both refused.
  if (isOpenDenied(requested)) return { ok: false, error: "denied_extension" };
  const target = await resolveExternalOpenTarget(requested);
  if (!target.ok) return target;
  if (isOpenDenied(target.real)) return { ok: false, error: "denied_extension" };
  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    info = await fs.stat(target.real);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!info.isFile()) return { ok: false, error: "not-a-file" };
  // A POSIX file with any execute bit runs as a program when opened (a cloned repo's +x `build.command`, an extensionless
  // script); Windows has no such bit and relies on the extension lists above.
  if (process.platform !== "win32" && (Number(info.mode) & 0o111) !== 0) return { ok: false, error: "executable" };
  return target;
}

/**
 * Hand one regular file to the OS default app. The whole judgement (deny lists on both names, sensitive floor, regular
 * non-executable file) runs on the first resolution and again on a fresh resolution immediately before the open. `authorize`
 * is the caller's authority (picker allowlist, preview receipt, project containment, and on the final pass the sender), so the
 * exact target that is opened is the one every check judged.
 */
export async function openVerifiedExternalFile<A extends string>(
  requested: string,
  authorize: (real: string, pass: ExternalOpenPass) => A | null,
): Promise<{ ok: true; real: string } | { ok: false; error: ExternalOpenRefusal | A }> {
  const target = await judgeOpenTarget(requested);
  if (!target.ok) return target;
  const first = authorize(target.real, "first");
  if (first !== null) return { ok: false, error: first };
  const current = await judgeOpenTarget(requested);
  if (!current.ok) return current;
  const last = authorize(current.real, "final");
  if (last !== null) return { ok: false, error: last };
  if (current.real !== target.real) return { ok: false, error: "changed" };
  const failure = await shell.openPath(current.real);
  return failure ? { ok: false, error: "open-failed" } : { ok: true, real: current.real };
}
