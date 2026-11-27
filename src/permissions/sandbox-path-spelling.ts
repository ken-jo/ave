// Portions derived from @anthropic-ai/sandbox-runtime (Apache-2.0) and modified; see THIRD-PARTY-NOTICES.
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

export function expandWindowsEnvRefs(path: string, options?: {
  home: string;
  onReference: (replacement: string, offset: number, length: number) => void;
}): string {
  const home = options?.home ?? os.homedir();
  const drive = /^[A-Za-z]:/.test(home) ? home.slice(0, 2) : "";
  const references = { USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) };
  return path.replace(/%(USERPROFILE|HOMEDRIVE|HOMEPATH)%/gi, (token, name: string, offset: number) => {
    const replacement = references[name.toUpperCase() as keyof typeof references];
    options?.onReference(replacement, offset, token.length);
    return replacement;
  });
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
