import { win32 } from "node:path";

/** A system executable must never fall back to a search of the caller's PATH. */
export function windowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const root of [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR]) {
    if (!root || root.length > 512 || !/^[a-z]:[\\/]/i.test(root) || /[\u0000-\u001f\u007f*?"<>|]/.test(root)
      || root.slice(2).includes(":")) continue;
    return win32.normalize(root);
  }
  throw new Error("Windows system root is missing or is not an absolute local path");
}

/**
 * Program Files roots for locating optional bundled tooling (e.g. Git for Windows). Unlike
 * windowsSystemRoot this never has to resolve: a caller that finds nothing here falls back to a PATH
 * lookup, so an absent or malformed environment yields the conventional roots on the system drive
 * rather than throwing. Roots are shape-validated like windowsSystemRoot and any drive is allowed.
 */
export function windowsProgramFilesRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const accept = (value: string | undefined): void => {
    if (!value || value.length > 512 || !/^[a-z]:[\\/]/i.test(value) || /[\u0000-\u001f\u007f*?"<>|]/.test(value)
      || value.slice(2).includes(":")) return;
    const normalized = win32.normalize(value);
    // A Program Files root is always a direct child of a drive root (e.g. C:\Program Files). Refusing a
    // deeper path keeps an environment-redirected interpreter out of a user-writable tree: the old code
    // only ever executed the hardcoded admin-only roots, so this preserves that floor while allowing any
    // drive. A rejected value falls through to the system-drive roots below, which is the safe answer.
    const parsed = win32.parse(normalized);
    if (parsed.dir !== parsed.root) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(normalized);
  };
  // The native 64-bit root first (the historical C:\Program Files preference), then the 32-bit root;
  // on a 64-bit host ProgramW6432 and ProgramFiles coincide and dedupe to a single entry.
  accept(env.ProgramW6432);
  accept(env.ProgramFiles);
  accept(env["ProgramFiles(x86)"]);
  if (roots.length === 0) {
    const drive = windowsSystemDrive(env);
    if (drive) {
      accept(win32.join(drive, "Program Files"));
      accept(win32.join(drive, "Program Files (x86)"));
    }
  }
  return roots;
}

function windowsSystemDrive(env: NodeJS.ProcessEnv): string | undefined {
  for (const value of [env.SystemDrive, env.SYSTEMDRIVE]) {
    if (value && /^[a-z]:[\\/]?$/i.test(value)) return `${value.slice(0, 2)}\\`;
  }
  try { return win32.parse(windowsSystemRoot(env)).root; }
  catch { return undefined; }
}

/** An empty name selects the system directory; names without an extension select executables. */
export function win32SystemBinary(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = windowsSystemRoot(env);
  if (win32.isAbsolute(name) || name.split(/[\\/]/).includes("..") || /[:\0]/.test(name)) {
    throw new Error("Windows system binary must be relative to System32");
  }
  return win32.join(root, "System32", name && !win32.extname(name) ? `${name}.exe` : name);
}
