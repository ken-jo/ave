import { lstatSync, realpathSync } from "node:fs";
import { win32 as winPath } from "node:path";
import { t } from "../i18n/index.js";
import { createAveHomeIfAbsent } from "../shared/ave-home.js";
import {
  admitWindowsReparse, isOwnerOnlyDacl, readWindowsDacls, windowsOwnerRules, windowsPathKey, type WindowsDaclFacts,
} from "../shared/windows-path-facts.js";

/** How the Windows runtime root is created and proved. Production uses `WINDOWS_RUNTIME_HOST`; a test replaces either. */
export interface MxcWindowsRuntimeHost {
  /** Create `path` with a protected descriptor that names this account alone. A directory already there is left as it is. */
  createPrivateDirectory(path: string): void;
  /** What the OS reports for `path` on a retained handle: identity, filesystem, every component's link state, descriptor. */
  readFacts(path: string): WindowsDaclFacts;
}

export const WINDOWS_RUNTIME_HOST: MxcWindowsRuntimeHost = Object.freeze({
  // The Ave home's create-only step: the owner-only protected descriptor is part of the creation, and it is read back.
  createPrivateDirectory: (path: string): void => { createAveHomeIfAbsent(path); },
  readFacts: (path: string): WindowsDaclFacts => {
    const [facts] = readWindowsDacls([path]);
    if (facts === undefined) throw new Error("The OS reported nothing for the path");
    return facts;
  },
});

/** A drive-letter path in normalized form: no share, device or extended prefix, no `.`/`..`, no forward slash. */
export function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:\\/u.test(path) && !/[\0*?"<>|]/u.test(path) && winPath.normalize(path) === path;
}

/**
 * The account's local application data directory. It is per-user, it never roams to another machine or a share as the
 * roaming one does, and nothing ages files out of it as storage cleanup does from the temp directory. A `LOCALAPPDATA`
 * that is not a drive path is ignored. The value is only a starting point: the root under it is proved by what the OS
 * reports (`windowsRuntimeRootFailure`).
 */
export function windowsLocalAppData(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const value = env.LOCALAPPDATA;
  return value !== undefined && isWindowsDrivePath(value) ? value.replace(/\\+$/u, "") : winPath.join(home, "AppData", "Local");
}

/**
 * Why the directory at `planned` cannot be the runtime root, or undefined when it can: a real directory on an NTFS
 * volume, reached through no link or junction, whose path is the planned one (a mapped drive or a share reports
 * another), owned by this account, with a protected descriptor whose only granting entry is this account's inheritable
 * full control. Deny entries grant nothing and are ignored: the sandbox account's read deny is stamped on this root.
 */
export function windowsRuntimeRootFailure(facts: WindowsDaclFacts, planned: string): string | undefined {
  if (facts.exists !== true || !facts.directory) return "it is not a directory";
  if (admitWindowsReparse(facts, "evidence") !== true) return "it is a link or junction, or lies below one";
  // Access control lists are an NTFS feature; a volume that does not report its filesystem is not assumed to have them.
  if (facts.fileSystemName !== "NTFS") return "it is not on an NTFS volume";
  if (facts.canonical === null || windowsPathKey(facts.canonical) !== windowsPathKey(planned)) {
    return "it resolves to another path: a share, a mapped drive or an alias";
  }
  const dacl = facts.dacl;
  if (dacl === null || dacl.nullDacl) return "it has no access control list";
  if (!dacl.protected) return "it inherits access from the directory above it";
  let rules: ReturnType<typeof windowsOwnerRules>;
  try {
    rules = windowsOwnerRules(dacl);
  } catch {
    return "its access control list has an entry of an unknown kind";
  }
  // An elevated run created it: its owner is the Administrators group, which a normal run of this account is not.
  if (dacl.owner === "S-1-5-32-544" && !facts.elevated) return t("be_mxcRuntimeRoot.elevatedOwned", { path: planned });
  if (!isOwnerOnlyDacl({ ownerSid: dacl.owner, elevated: facts.elevated, rules }, facts.currentUserSid)) {
    return "it is another account's, or open to other accounts";
  }
  return undefined;
}

/**
 * Why the established root at `root` is no longer reached the way it was proved, or undefined when it is: the root,
 * the app's directory and the local application data directory are each a real directory, and the path resolves to
 * itself. A renamed directory with a junction planted at its name still leads to the same root, so the root's identity
 * alone does not show it.
 */
export function windowsRuntimeRootMoved(root: string): string | undefined {
  const appDirectory = winPath.dirname(root);
  try {
    for (const path of [root, appDirectory, winPath.dirname(appDirectory)]) {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return `${path} is now a link, a junction or not a directory`;
    }
    const resolved = realpathSync.native(root);
    return windowsPathKey(resolved) === windowsPathKey(root) ? undefined : `it now resolves to ${resolved}`;
  } catch (error) {
    return `its path could not be read again: ${(error as Error).message}`;
  }
}
