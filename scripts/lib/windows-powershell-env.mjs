import { win32 } from "node:path";

export function windowsPowerShellEnv(env = process.env) {
  // Let the child rebuild its edition-specific module search path.
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}

export function windowsPowerShellPath(env = process.env) {
  const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === "systemroot")?.[1];
  if (!/^[a-z]:[\\/]/iu.test(systemRoot ?? "")) {
    throw new Error("Windows PowerShell requires an absolute system directory");
  }
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
