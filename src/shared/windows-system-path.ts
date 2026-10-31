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

/** An empty name selects the system directory; names without an extension select executables. */
export function win32SystemBinary(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = windowsSystemRoot(env);
  if (win32.isAbsolute(name) || name.split(/[\\/]/).includes("..") || /[:\0]/.test(name)) {
    throw new Error("Windows system binary must be relative to System32");
  }
  return win32.join(root, "System32", name && !win32.extname(name) ? `${name}.exe` : name);
}
