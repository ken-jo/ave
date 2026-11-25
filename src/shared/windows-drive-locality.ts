import { spawnSync } from "node:child_process";
import { resolveWindowsPathKindHelper } from "../main/windows-path-kind-launcher.js";
import { decodeWindowsNativeReply, runWindowsNative } from "./windows-native-host.js";

// The drive query opens nothing, so its timeout only bounds a hung helper.
const QUERY_TIMEOUT_MS = 5_000;
// The helper's one answer about a drive: the OS has no mapping for it (native/windows-path-kind/README.md).
const EXIT_NO_MAPPING = 1;

/** The MS-DOS device mapping of a drive (`X:`) as QueryDosDeviceW reads it, or null when the OS has none. */
type DriveQuery = (drive: string) => string | null;

function queryWithHelper(drive: string): string | null {
  const result = runWindowsNative(() => spawnSync(resolveWindowsPathKindHelper(), [drive], {
    windowsHide: true, shell: false, timeout: QUERY_TIMEOUT_MS, encoding: "buffer",
  }));
  if (result.error) throw result.error;
  if (result.status === EXIT_NO_MAPPING) return null;
  const mapping = decodeWindowsNativeReply(result.stdout).replace(/\r?\n$/u, "");
  if (result.status !== 0 || mapping.length === 0 || /[\r\n]/u.test(mapping)) throw new Error(`The Windows drive classifier gave no mapping for ${drive}`);
  return mapping;
}

let query: DriveQuery = queryWithHelper;

/** Replaces the drive query; without an argument the shipped helper answers again. */
export function setWindowsDriveQueryForTest(next?: DriveQuery): void {
  query = next ?? queryWithHelper;
}

/**
 * What drive `drive` (`X:`) names, from a fresh query of its mapping alone: a local volume, or the share a redirector
 * names, or an opaque device spelling. `absent` when the OS has no mapping for the drive. A drive the classifier cannot
 * answer for is opaque, and so is any substitute drive: its backing path is not walked, so nothing proves it local.
 * Callers keep an answer for one decision at most (`local-path-io.ts`).
 */
export type DriveIdentity = { local: true } | { local: false; root: string; absent: boolean };

export function queryDriveIdentity(drive: string): DriveIdentity {
  const letter = drive.toUpperCase();
  const opaque = `\\\\?\\GLOBALROOT\\??\\${letter}`;
  let mapping: string | null;
  try { mapping = query(letter); } catch { return { local: false, root: opaque, absent: false }; }
  if (mapping === null) return { local: false, root: opaque, absent: true };
  if (/^\\Device\\(?:HarddiskVolume|CdRom|Floppy)\d+$/iu.test(mapping)) return { local: true };
  const [, unc] = /^\\\?\?\\UNC\\(.+)$/isu.exec(mapping) ?? [];
  if (unc !== undefined) return { local: false, root: `\\\\${unc}`, absent: false };
  // `;Z:0000…` and `;LanmanRedirector` are the redirector's own prefixes; the server and share follow them.
  const [, redirected = ""] = /^\\Device\\(?:Mup|LanmanRedirector|WebDavRedirector|RdpDr)\\(.*)$/isu.exec(mapping) ?? [];
  const share = redirected.split("\\").filter(part => part !== "" && !part.startsWith(";"));
  return { local: false, root: share.length >= 2 ? `\\\\${share.join("\\")}` : `\\\\?\\GLOBALROOT${mapping}`, absent: false };
}
