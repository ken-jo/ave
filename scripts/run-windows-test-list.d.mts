export const WINDOWS_TEST_SHARDS: readonly [1, 2, 3];
export const WINDOWS_TEST_LISTS: readonly [
  "config/windows-permission-tests.txt",
  "config/windows-native-tests.txt",
  "config/windows-application-tests.txt",
];
export function windowsTestFiles(text: string): string[];
export function windowsTestCommands(text: string, bun?: string): string[][];
export function plannedWindowsFiles(inventory: string, text: string, plan: unknown, shard?: number): string[];
