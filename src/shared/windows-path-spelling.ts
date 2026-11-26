import { hostname } from "node:os";
import { win32 } from "node:path";

// Both fold case without the `u` flag, so only ASCII letters fold: a Kelvin sign or long s never passes for `k` or `s`.
const LOOPBACK_HOST = /^(?:localhost|127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|::1|\[::1\]|0--1\.ipv6-literal\.net)$/i;
// `\\.\X:` and `\\?\X:` devices, `\\.\UNC\host\X$` and `\\?\UNC\host\X$`, and `\\host\X$`, with either separator.
const DRIVE_ALIAS = /^[\\/]{2}(?:[.?][\\/](?:([a-z]):|unc[\\/]([^\\/]+)[\\/]([a-z])\$)|([^\\/]+)[\\/]([a-z])\$)((?:[\\/][^\\/]*)*)$/i;

/**
 * What a spelling names before anything is opened, read from its text alone:
 *   local-drive    a drive-absolute path, or `\\?\X:\` before one (off Windows, every path; `drive` is then absent);
 *   share          a `\\host\share` path, or its `\\?\UNC\` or `\\.\UNC\` form (`extended`);
 *   device-opaque  any other `\\.\` or `\\?\` device path;
 *   ambiguous      a spelling Windows may read as another object than the path model names;
 *   unanchored     a relative, root-relative or drive-relative path, which names nothing until it is anchored.
 * `driveAlias` is the plain drive spelling of an extended drive path, or of a device or loopback administrative-share alias
 * of a local drive.
 */
export type WindowsSpelling =
  | { kind: "local-drive"; drive?: string; driveAlias?: string }
  | { kind: "share"; host: string; loopback: boolean; extended: boolean; driveAlias?: string }
  | { kind: "device-opaque"; driveAlias?: string }
  | { kind: "ambiguous" }
  | { kind: "unanchored" };

export function classifyWindowsSpelling(path: string, platform: NodeJS.Platform = process.platform): WindowsSpelling {
  if (platform !== "win32") return { kind: "local-drive" };
  if (ambiguous(path)) return { kind: "ambiguous" };
  const driveAlias = aliasOf(path);
  const drive = /^(?:[\\/]{2}\?[\\/])?([A-Za-z]):[\\/]/u.exec(path)?.[1];
  if (drive !== undefined) return { kind: "local-drive", drive: `${drive.toUpperCase()}:`, ...(driveAlias ? { driveAlias } : {}) };
  if (!/^[\\/]{2}[^\\/]/u.test(path)) return { kind: "unanchored" };
  const [, extended, host = ""] = /^[\\/]{2}(?:([.?])[\\/](?:unc(?:[\\/]|$))?)?([^\\/]*)/iu.exec(path) ?? [];
  if (extended !== undefined && !/^[\\/]{2}[.?][\\/]unc(?:[\\/]|$)/iu.test(path)) return { kind: "device-opaque", ...(driveAlias ? { driveAlias } : {}) };
  return { kind: "share", host, loopback: isLocalHost(host), extended: extended !== undefined, ...(driveAlias ? { driveAlias } : {}) };
}

/**
 * Whether Windows may open another object than the path model names: the NT `\??\` prefix, which Win32 passes through
 * unparsed, or a share or device spelling with a component ending in a dot or space (`.` and `..` included), or, after
 * `\\?\`, a slash or an empty component; the model trims, collapses or splits those where the namespace keeps them.
 */
export function isAmbiguousNativeSpelling(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return classifyWindowsSpelling(path, platform).kind === "ambiguous";
}

/**
 * The drive spelling of a device or loopback administrative-share alias of a local drive, found without filesystem
 * access. Undefined when the spelling is no such alias or does not provably name the same file through the drive: a bare
 * volume device, or an ambiguous spelling (`isAmbiguousNativeSpelling`).
 */
export function localDriveAlias(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const spelling = classifyWindowsSpelling(path, platform);
  return spelling.kind === "share" || spelling.kind === "device-opaque" || spelling.kind === "local-drive" ? spelling.driveAlias : undefined;
}

/** Classify native network/device identities without opening their namespace. */
export function isWindowsNetworkOrDevicePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const { kind } = classifyWindowsSpelling(path, platform);
  return kind === "share" || kind === "device-opaque" || kind === "ambiguous";
}

function ambiguous(path: string): boolean {
  if (/^[\\/]\?\?[\\/]/u.test(path)) return true;
  if (!/^[\\/]{2}/u.test(path)) return false;
  const tail = path.replace(/^[\\/]{2}[.?](?=[\\/]|$)/u, "");
  if (path.startsWith("\\\\?\\") && /\/|\\\\/u.test(tail.slice(1))) return true;
  return tail.split(/[\\/]/u).some(segment => /[. ]$/u.test(segment));
}

function isLocalHost(host: string): boolean {
  return /^[!-~]+$/u.test(host) && (LOOPBACK_HOST.test(host) || host.toLowerCase() === hostname().toLowerCase());
}

function aliasOf(path: string): string | undefined {
  const match = DRIVE_ALIAS.exec(path);
  if (match === null) return undefined;
  const [, device, extendedHost, extendedDrive, host, shareDrive, rest = ""] = match;
  const shareHost = extendedHost ?? host;
  if (shareHost !== undefined && !isLocalHost(shareHost)) return undefined;
  if (device !== undefined && rest === "") return undefined;
  const segments = rest.split(/[\\/]/u).filter(Boolean);
  const drive = device ?? extendedDrive ?? shareDrive;
  return drive === undefined ? undefined : `${drive.toUpperCase()}:\\${segments.join("\\")}`;
}

/** `win32.normalize`, keeping a `\\?\` or `\\?\UNC\` prefix and normalizing only what follows it. */
export function normalizeWindowsPathSpelling(path: string): string {
  const device = /^[\\/]{1,2}\?[\\/](.*)$/.exec(path)?.[1];
  if (device === undefined) return win32.normalize(path);
  if (/^UNC[\\/]/i.test(device)) return `\\\\?\\UNC\\${win32.normalize(`\\\\${device.slice(4)}`).slice(2)}`;
  return `\\\\?\\${win32.normalize(device)}`;
}

export function isFullyQualifiedWindowsPath(path: string): boolean {
  return win32.isAbsolute(path) && windowsVolumeRoot(path).length > 1;
}

export function windowsVolumeRoot(path: string): string {
  const device = /^[\\/]{1,2}\?[\\/](.*)$/.exec(path)?.[1];
  if (device !== undefined && /^UNC[\\/]/i.test(device)) {
    return `\\\\?\\UNC\\${win32.parse(`\\\\${device.slice(4)}`).root.slice(2)}`;
  }
  return win32.parse(path).root;
}
