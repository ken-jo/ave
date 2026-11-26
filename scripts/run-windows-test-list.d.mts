export const WINDOWS_TEST_SHARDS: readonly [1, 2, 3, 4, 5, 6];
export const WINDOWS_TIER_TEST_SHARDS: readonly [1, 2, 3];
export type WindowsPlanTier = "native" | "census";
export interface WindowsTestPlan {
  suites: number;
  shards: { id: number; files: string[]; weightMs: number }[];
  tiers: WindowsPlanTier[];
  tierShards: { id: number; files: string[]; weightMs: number }[];
}
export function defaultWindowsSuites(collected: readonly string[]): string[];
export function tierWindowsSuites(collected: readonly string[], tiers: readonly WindowsPlanTier[]): string[];
export function windowsTestCommands(files: readonly string[], bun?: string): string[][];
export function assertWindowsPlan(plan: unknown, collected: readonly string[]): asserts plan is WindowsTestPlan;
export function windowsShardFiles(plan: unknown, shard: number, root: string, tier?: "default" | "tiers"): string[];
