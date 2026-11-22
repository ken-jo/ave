import { statSync, type Stats } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { win32SystemBinary } from "../../shared/windows-system-path.js";

export interface ManualShellLaunch { readonly command: string; readonly args: string[] }

export function isLaunchableFile(
  path: string,
  stat: (path: string, options: { throwIfNoEntry: false }) => Pick<Stats, "isFile"> | undefined = statSync,
): boolean {
  // Follow links to files; inaccessible app execution aliases fail the same stat check as launch.
  try { return stat(path, { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
}

// Native interactive argv, independent of the command tool's POSIX resolver. `preferred` is the shell the user set for their terminals; it must be
// what any interpreter here must be (an absolute path to a file, a native executable on Windows), and a setting that is not is an error the terminal
// shows, never a reason to start a different shell than the one asked for.
export function resolveManualShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (path: string) => boolean = isLaunchableFile,
  preferred = "",
): ManualShellLaunch {
  if (preferred !== "") {
    const absolute = platform === "win32" ? win32.isAbsolute(preferred) && win32.extname(preferred).toLowerCase() === ".exe" : isAbsolute(preferred);
    if (!absolute) throw new Error(`the shell set for terminals must be an absolute path${platform === "win32" ? " to an .exe" : ""}: ${preferred}`);
    if (!isFile(preferred)) throw new Error(`the shell set for terminals is not a file: ${preferred}`);
    return { command: preferred, args: platform === "win32" ? [] : ["-l", "-i"] };
  }
  if (platform === "win32") {
    const isAbsoluteEntry = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path);
    // Prefer the exact PATH key, otherwise the first case-insensitive match.
    const path = Object.hasOwn(env, "PATH") ? env.PATH : Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    const programFiles = Object.entries(env).find(([key]) => key.toUpperCase() === "PROGRAMFILES")?.[1];
    const candidates = (path ?? "").split(";")
      .map((entry) => entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry)
      .filter(isAbsoluteEntry).map((entry) => win32.join(entry, "pwsh.exe"));
    if (programFiles && isAbsoluteEntry(programFiles)) candidates.push(win32.join(programFiles, "PowerShell", "7", "pwsh.exe"));
    const selected = candidates.find((candidate) => isFile(candidate)) ?? env.COMSPEC;
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
