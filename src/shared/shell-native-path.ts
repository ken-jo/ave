import { isAbsolute, normalize, parse, resolve, sep, win32 } from "node:path";
import { localDriveExists } from "./local-path-io.js";
import { normalizeWindowsPathSpelling as normalizeWindowsPath, windowsVolumeRoot } from "./windows-path-spelling.js";

export { isAmbiguousNativeSpelling, isWindowsNetworkOrDevicePath, localDriveAlias } from "./windows-path-spelling.js";

/** The spelling without alternate-stream suffixes (`name:stream:$TYPE`) after its root; a stream is data of the same file. */
export function withoutStreamSuffixes(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const root = /^(?:[\\/]{2}[.?][\\/]unc[\\/][^\\/]*[\\/][^\\/]*|[\\/]{2}[.?][\\/][^\\/]*|[\\/]{2}[^\\/]*[\\/][^\\/]*|[a-z]:)?/iu.exec(path)?.[0] ?? "";
  return root + path.slice(root.length).replace(/:[^\\/]*/gu, "");
}

export type ShellPathDialect = "native" | "powershell" | "bash";
export interface ShellPathModel {
  dialect: ShellPathDialect;
  /** The execution location, rather than the host process's current directory. */
  location?: string;
}
export interface NativeShellPath {
  /** Retains parent components for physical directory-link inspection. */
  nativePath: string | undefined;
  normalizedPath: string;
  volumeRoot: string;
  /** Additional sensitive-floor probes; these never establish filesystem authority. */
  floorPaths: readonly string[];
}

function windowsFloorPaths(path: string): string[] {
  let value = path.replaceAll("\\", "/");
  value = value.replace(/^\/\/?\?\//, "");
  if (/^UNC\//i.test(value)) value = "//" + value.slice(4);
  const drive = /^[A-Za-z]:\/?(.*)$/.exec(value);
  if (drive) return ["/" + drive[1]];
  const unc = /^\/\/[^/]+\/([^/]+)(.*)$/.exec(value);
  // The share is a volume root: retain its name as well as its mounted suffix.
  if (unc) return [...new Set(["/" + unc[1] + unc[2], unc[2] || "/"])];
  return [value.startsWith("/") ? value : "/" + value];
}

// Filesystem syntax is defined positively: no `:`, a drive-absolute path, or UNC. Every other colon form (provider
// drives, `Provider::`, module-qualified providers, drive-relative `C:x`, a drive path with a stream suffix) gets no
// filesystem authority.
export function isPowerShellFilesystemSyntax(path: string): boolean {
  return !path.includes(":") || /^[A-Za-z]:[\\/][^:]*$/.test(path) || /^[\\/]{2}/.test(path);
}

export function modelShellPath(path: string, model: ShellPathModel): NativeShellPath {
  if (model.dialect === "powershell" && !isPowerShellFilesystemSyntax(path)) {
    return { nativePath: undefined, normalizedPath: path, volumeRoot: "", floorPaths: [] };
  }
  if (sep !== "\\") {
    // Host path operations, so a simulated drive keeps its win32 spelling.
    const absolute = isAbsolute(path) ? path : resolve(model.location ?? "/", path);
    return { nativePath: absolute, normalizedPath: normalize(absolute), volumeRoot: parse(absolute).root, floorPaths: [] };
  }
  // Normalize the accepted device spelling before applying native root rules.
  const native = path.replace(/^\\\?\\(?=[A-Za-z]:[\\/])/, "\\\\?\\");
  const root = win32.parse(native).root;
  let absolute: string | undefined;
  // The NT prefix is passed through by the Win32 path rules, not read against the current drive; it stays as spelled.
  if (/^[A-Za-z]:[\\/]/.test(native) || root.length > 1 && /^[\\/]{2}/.test(native) || /^[\\/]\?\?[\\/]/u.test(native)) absolute = native;
  else if (/^[A-Za-z]:/.test(native)) absolute = undefined;
  else if (root.length === 1) {
    if (model.dialect === "bash") {
      const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(native);
      if (drive && localDriveExists(`${drive[1]}:`)) absolute = `${drive[1]}:/${drive[2] ?? ""}`;
      // A leading backslash is drive-root-relative; a leading slash remains in the unresolved shell root namespace.
      else if (!drive && /^\\/.test(native)) absolute = win32.parse(win32.resolve("/")).root + native.slice(1);
    } else if (model.location !== undefined) {
      const locationRoot = win32.parse(model.location).root;
      if (/^[A-Za-z]:[\\/]$/.test(locationRoot)) absolute = locationRoot + native.slice(1);
    }
  } else if (model.location !== undefined) absolute = `${model.location}\\${native}`;
  const normalizedPath = normalizeWindowsPath(absolute ?? native);
  return { nativePath: absolute, normalizedPath, volumeRoot: windowsVolumeRoot(normalizedPath), floorPaths: windowsFloorPaths(normalizedPath) };
}
