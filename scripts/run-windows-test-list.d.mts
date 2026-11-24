export const WINDOWS_TEST_SHARDS: readonly [1, 2, 3, 4, 5];
export interface WindowsTestPlan {
  suites: number;
  shards: { id: number; files: string[]; weightMs: number }[];
}
export function windowsTestCommands(files: readonly string[], bun?: string): string[][];
export function assertWindowsPlan(plan: unknown, collected: readonly string[]): asserts plan is WindowsTestPlan;
export function windowsShardFiles(plan: unknown, shard: number, root: string): string[];
