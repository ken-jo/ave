import { isAbsolute, win32 } from "node:path";
import { win32SystemBinary } from "../../shared/windows-system-path.js";

export interface ManualShellLaunch { readonly command: string; readonly args: string[] }

// Native interactive argv, independent of the command tool's POSIX resolver.
export function resolveManualShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ManualShellLaunch {
  if (platform === "win32") {
    const selected = env.COMSPEC;
    const command = selected ?? win32SystemBinary("cmd", env);
    if (!win32.isAbsolute(command) || win32.extname(command).toLowerCase() !== ".exe") {
      throw new Error("terminal interpreter must be an absolute native executable");
    }
    return { command, args: [] };
  }
  const command = env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  if (!isAbsolute(command)) throw new Error("terminal interpreter must be an absolute path");
  return { command, args: ["-l", "-i"] };
}
