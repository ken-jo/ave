// One default-app open sequence for every host channel that hands a file to the OS (attach.openExternal, workspace.openPath).
import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, parse, resolve } from "node:path";
import { DENY_EXTENSIONS as DENY_LIST } from "../shared/attachments-deny-list.js";
import { canonicalizePathForMatch, caseFoldForMatch, isSensitivePath } from "../permissions/sensitive-paths.js";
import { isWindowsNetworkOrDevicePath } from "../shared/shell-native-path.js";
import { canOpenInDefaultApp } from "../shared/preview-external-open.js";

const DENY_EXTENSIONS = new Set<string>(DENY_LIST);

/** Link hops followed while checking a chain, as the OS's own symlink limit. */
const MAX_LINK_HOPS = 40;

/** Refusals this sequence itself produces; callers add their own authority codes. */
export type ExternalOpenRefusal =
  | "not-found" | "sensitive-path" | "denied_extension" | "type-not-allowed" | "network-target" | "executable" | "not-a-file"
  | "changed" | "open-failed";

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

/** The shared allow list (`shared/preview-external-open.ts`): both the requested name and its target must be on it. */
function isOpenAllowed(path: string): boolean {
  return canOpenInDefaultApp(path);
}

/** A UNC or device spelling, judged as Windows reads it on every platform. */
function isNetworkOrDevice(path: string): boolean {
  return isWindowsNetworkOrDevicePath(path, "win32");
}

/** Whether a readlink string has a `..` segment. */
function climbs(path: string): boolean {
  return path.split(/[\\/]+/u).includes("..");
}

/**
 * Walk `path` one component at a time with lstat and readlink only, following each link lexically, so nothing is resolved
 * through a link before its target is known to be local. "network" when any hop names a UNC or device location (resolving it
 * would make Windows authenticate to that host) or the chain is too long; "missing" when a component does not exist.
 */
export async function linkChainVerdict(path: string): Promise<"local" | "network" | "missing"> {
  if (isNetworkOrDevice(path)) return "network";
  // Callers refuse a requested path with a `.` or `..` segment before this walk, so `resolve` folds nothing here.
  const start = resolve(path);
  let current = parse(start).root;
  const rest = start.slice(current.length).split(/[\\/]+/u).filter(Boolean);
  let hops = 0;
  while (rest.length > 0) {
    const component = rest.shift()!;
    const next = resolve(current, component);
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(next)).isSymbolicLink();
    } catch {
      return "missing";
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return "network";
    const target = await fs.readlink(next);
    // A link target's `..` folds against the physical parent of whatever comes before it, which a lexical follow cannot see:
    // such a target is refused like a hop that cannot be judged local.
    if (climbs(target)) return "network";
    const followed = resolve(current, target);
    if (isNetworkOrDevice(target) || isNetworkOrDevice(followed)) return "network";
    current = parse(followed).root;
    rest.unshift(...followed.slice(current.length).split(/[\\/]+/u).filter(Boolean));
  }
  return "local";
}

/** Check the link chain lexically, resolve, require an allowed format on both names and a regular non-executable file. */
async function judgeOpenTarget(requested: string): Promise<{ ok: true; real: string } | { ok: false; error: ExternalOpenRefusal }> {
  // The requested spelling and its target are both judged: `notes.sh -> notes.txt` and `notes.txt -> run.sh` are both refused.
  if (!isOpenAllowed(requested)) return { ok: false, error: "type-not-allowed" };
  const chain = await linkChainVerdict(requested);
  if (chain === "network") return { ok: false, error: "network-target" };
  if (chain === "missing") return { ok: false, error: "not-found" };
  const target = await resolveExternalOpenTarget(requested);
  // The picker deny list is narrower than the allow list; both say the target's type is not opened.
  if (!target.ok) return target.error === "denied_extension" ? { ok: false, error: "type-not-allowed" } : target;
  if (!isOpenAllowed(target.real)) return { ok: false, error: "type-not-allowed" };
  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    info = await fs.stat(target.real);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!info.isFile()) return { ok: false, error: "not-a-file" };
  // A POSIX file with any execute bit runs as a program when opened (a cloned repo's +x `build.command`, an extensionless
  // script); Windows has no such bit and relies on the allow list above. Volumes that report every file as 0777 (exFAT, SMB,
  // WSL /mnt/c) refuse everything here; the message tells the user to open it from the file manager instead.
  if (process.platform !== "win32" && (Number(info.mode) & 0o111) !== 0) return { ok: false, error: "executable" };
  return target;
}

/**
 * Hand one regular file to the OS default app. The whole judgement (allow list on both names, a local link chain, sensitive
 * floor, regular non-executable file) runs on the first resolution and again on a fresh resolution immediately before the
 * open. `authorize`
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
