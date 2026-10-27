import { closeSync, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import type { WindowsPathFacts } from "./windows-path-facts.js";
import { runWindowsNative } from "./windows-native-host.js";

type ConfigurationFacts = Pick<WindowsPathFacts, "volumeSerialNumber" | "fileIndex" | "changeTime" | "directory" | "fileSystemName">;
export interface WindowsConfigurationHandleEntry {
  readonly path: string;
  readonly facts: ConfigurationFacts;
  readonly changeTimeRequired: boolean;
}

export function windowsConfigurationDirectoryEntries(path: string, facts: WindowsPathFacts, changeTimeRequired = true): WindowsConfigurationHandleEntry[] {
  return [...facts.ancestors.map(ancestor => ({
    // The filesystem runtime strips the separator from a namespaced drive root when opening it.
    path: ancestor.canonical!.replace(/^\\\\\?\\([a-z]:\\)$/i, "$1"), facts: ancestor, changeTimeRequired: false,
  })),
    { path, facts, changeTimeRequired }];
}

export interface WindowsConfigurationHandles {
  readonly descriptors: readonly number[];
  matches(): boolean;
  close(): void;
}

export function matchesWindowsConfigurationFacts(stat: BigIntStats, entry: WindowsConfigurationHandleEntry): boolean {
  const { facts } = entry;
  // The 64-bit runtime index is unique only on the certified filesystem and volume.
  return facts.fileSystemName === "NTFS" && facts.volumeSerialNumber !== null && facts.fileIndex !== null
    && BigInt(facts.volumeSerialNumber) !== 0n && BigInt(facts.fileIndex) !== 0n
    && stat.dev === BigInt(facts.volumeSerialNumber) && stat.ino === BigInt(facts.fileIndex)
    && (facts.directory ? stat.isDirectory() : stat.isFile())
    && (!entry.changeTimeRequired || (facts.changeTime !== null && BigInt(facts.changeTime) !== 0n
      && stat.ctimeNs === (BigInt(facts.changeTime) - 116444736000000000n) * 100n));
}

/** Retain every handle through the read; path checks bind directories to their admitted names. */
export function openWindowsConfigurationHandles(entries: readonly WindowsConfigurationHandleEntry[]): {
  handles: WindowsConfigurationHandles | undefined;
  fileOpened: boolean;
} {
  const descriptors: number[] = [];
  let fileOpened = false;
  const close = (): void => { for (const descriptor of descriptors.splice(0)) closeSync(descriptor); };
  const matches = (): boolean => {
    try {
      return entries.every((entry, index) => {
        const stat = fstatSync(descriptors[index]!, { bigint: true });
        if (!matchesWindowsConfigurationFacts(stat, entry)) return false;
        if (!entry.facts.directory) return true;
        // A followed junction can reach the old object. Its directory entry must match too.
        const named = lstatSync(entry.path, { bigint: true });
        return named.isDirectory() && named.dev === stat.dev && named.ino === stat.ino;
      });
    } catch { return false; }
  };
  return runWindowsNative(() => {
    try {
      for (const entry of entries) {
        descriptors.push(openSync(entry.path, "r"));
        if (!entry.facts.directory) fileOpened = true;
      }
      if (matches()) return { handles: { descriptors, matches, close }, fileOpened };
    } catch { /* Missing or unstatable handles require native verification. */ }
    close();
    return { handles: undefined, fileOpened };
  });
}
