// Portions derived from @anthropic-ai/sandbox-runtime (Apache-2.0); see THIRD-PARTY-NOTICES.
// Path and pattern spelling helpers shared by the filesystem policy builders.
import os from "node:os";
import { posix, win32 } from "node:path";

export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase();
}

export function containsGlobChars(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

// Brackets are ordinary file-name characters on Windows.
export function containsGlobCharsWin(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

// `\\?\C:\x` is `C:\x`; `\\?\UNC\server\share` is `\\server\share`.
export function stripExtendedPathPrefix(path: string): string {
  if (/^\\\\\?\\unc\\/i.test(path)) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

export function isUncPath(path: string): boolean {
  return /^[\\/]{2}[?.][\\/]unc[\\/]/i.test(win32.toNamespacedPath(path));
}

export function expandWindowsEnvRefs(path: string): string {
  const home = os.homedir();
  const drive = /^[A-Za-z]:/.test(home) ? home.slice(0, 2) : "";
  return path
    .replace(/%USERPROFILE%/gi, home)
    .replace(/%HOMEDRIVE%/gi, drive)
    .replace(/%HOMEPATH%/gi, home.slice(drive.length));
}

// The directory a forward-slash pattern cannot match above; empty when the pattern starts with a wildcard.
export function globPatternBaseDir(pattern: string): string {
  const fixed = pattern.split(/[*?[\]]/)[0];
  if (!fixed) return "";
  return fixed.endsWith("/") ? fixed.slice(0, -1) : posix.dirname(fixed);
}

export function toForwardSlashes(path: string): string {
  return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}
