import { isAbsolute, normalize, parse, resolve, sep, win32 } from "node:path";
import { existsSync } from "node:fs";

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

function normalizeWindowsPath(path: string): string {
  const device = /^[\\/]{1,2}\?[\\/](.*)$/.exec(path)?.[1];
  if (device === undefined) return win32.normalize(path);
  if (/^UNC[\\/]/i.test(device)) return "\\\\?\\UNC\\" + win32.normalize("\\\\" + device.slice(4)).slice(2);
  return "\\\\?\\" + win32.normalize(device);
}

function windowsVolumeRoot(path: string): string {
  const device = /^[\\/]{1,2}\?[\\/](.*)$/.exec(path)?.[1];
  if (device !== undefined && /^UNC[\\/]/i.test(device)) {
    return "\\\\?\\UNC\\" + win32.parse("\\\\" + device.slice(4)).root.slice(2);
  }
  return win32.parse(path).root;
}

export function modelShellPath(path: string, model: ShellPathModel): NativeShellPath {
  if (sep !== "\\") {
    // Host path operations, so a simulated drive keeps its win32 spelling.
    const absolute = isAbsolute(path) ? path : resolve(model.location ?? "/", path);
    return { nativePath: absolute, normalizedPath: normalize(absolute), volumeRoot: parse(absolute).root, floorPaths: [] };
  }
  // Normalize the accepted device spelling before applying native root rules.
  const native = path.replace(/^\\\?\\(?=[A-Za-z]:[\\/])/, "\\\\?\\");
  const root = win32.parse(native).root;
  let absolute: string | undefined;
  if (/^[A-Za-z]:[\\/]/.test(native) || root.length > 1 && /^[\\/]{2}/.test(native)) absolute = native;
  else if (/^[A-Za-z]:/.test(native)) absolute = undefined;
  else if (root.length === 1) {
    if (model.dialect === "bash") {
      const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(native);
      if (drive && existsSync(`${drive[1]}:/`)) absolute = `${drive[1]}:/${drive[2] ?? ""}`;
      else if (!drive && native.startsWith("/")) absolute = win32.parse(win32.resolve("/")).root + native.slice(1);
    } else if (model.location !== undefined) {
      const locationRoot = win32.parse(model.location).root;
      if (/^[A-Za-z]:[\\/]$/.test(locationRoot)) absolute = locationRoot + native.slice(1);
    }
  } else if (model.location !== undefined) absolute = `${model.location}\\${native}`;
  const normalizedPath = normalizeWindowsPath(absolute ?? native);
  return { nativePath: absolute, normalizedPath, volumeRoot: windowsVolumeRoot(normalizedPath), floorPaths: windowsFloorPaths(normalizedPath) };
}
