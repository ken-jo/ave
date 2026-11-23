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
export function assertWindowsMarkerPlacement(sources: ReadonlyMap<string, string>): void;
export function windowsPermissionInventory(sources: ReadonlyMap<string, string>): string;
export function windowsInventoryDiff<T extends WindowsDiffEntry>(changes: readonly T[], readVersion: ReadWindowsVersion | undefined): {
  ordinary: T[];
  suites: Map<string, Set<(typeof WINDOWS_TEST_LISTS)[0 | 1]>>;
  changed: boolean;
};
export const WINDOWS_TEST_REMOVALS: string;
export type WindowsInventoryPath = (typeof WINDOWS_TEST_LISTS)[number];
export function windowsCoverageDepartures(readVersion: ReadWindowsVersion): Map<string, WindowsInventoryPath>;
export function assertWindowsRemovalRecords(departures: ReadonlyMap<string, WindowsInventoryPath>, readVersion: ReadWindowsVersion): void;
