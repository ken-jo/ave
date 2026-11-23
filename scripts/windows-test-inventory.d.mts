export const WINDOWS_TEST_LISTS: readonly [
  "config/windows-permission-tests.txt",
  "config/windows-native-tests.txt",
  "config/windows-application-tests.txt",
];
export const WINDOWS_INVENTORY_LOCK: string;
export type WindowsDiffEntry = { path: string; status: string; oldMode?: string; newMode?: string };
export type ReadWindowsVersion = (path: string, side: "before" | "after") => string | null;
export function windowsTestFiles(text: string): string[];
export function hasWindowsInventoryMarker(source: string, marker: "windows-native" | "windows-permission"): boolean;
export function windowsPermissionInventory(sources: ReadonlyMap<string, string>, isCollectedVitestFile: (path: string) => boolean): string;
export function windowsInventoryDiff<T extends WindowsDiffEntry>(changes: readonly T[], readVersion: ReadWindowsVersion | undefined, isCollectedVitestFile: (path: string) => boolean): {
  ordinary: T[];
  suites: Map<string, Set<(typeof WINDOWS_TEST_LISTS)[0 | 1]>>;
  changed: boolean;
};
