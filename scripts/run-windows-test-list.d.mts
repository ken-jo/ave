export const WINDOWS_TEST_SHARDS: readonly [1, 2, 3];
export { WINDOWS_TEST_LISTS, windowsTestFiles } from "./windows-test-inventory.mjs";
export function windowsTestCommands(text: string, bun?: string): string[][];
export function plannedWindowsFiles(inventory: string, text: string, plan: unknown, shard?: number): string[];
