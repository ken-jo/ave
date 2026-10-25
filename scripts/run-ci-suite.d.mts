import type { GitRawDiffEntry } from "./hooks/pre-push-ref-updates.mjs";

export const MUST_RUN_TESTS_PATH: string;
export const AFFECTED_TEST_LIMIT: number;
export const COVERAGE_EVENTS: readonly string[];

export interface CiSuitePlan {
  mode: "full" | "affected";
  reason: string;
  tests: string[];
}

export declare function loadsComputedImport(text: string): boolean;
export declare function namedRepositoryPaths(testPath: string, text: string): string[];
export declare function namesChangedPath(named: string, changedPath: string): boolean;
export declare function expandMustRunTests(document: unknown, trackedTests: readonly string[]): string[];
export declare function selectCiTests(input: {
  baseRef?: string;
  changes: GitRawDiffEntry[];
  trackedTests: readonly string[];
  mustRunTests: readonly string[];
  readText: (path: string) => string | null;
  discoverRelated: (paths: string[]) => { source: string; tests: string[] }[] | null;
}): CiSuitePlan;
export declare function runsRepoCodeOutOfProcess(text: string): boolean;
export declare function testRunsRepoCodeOutOfProcess(testPath: string, readText: (path: string) => string | null): boolean;
export declare function runsCoverage(eventName: string | undefined): boolean;
export const FULL_RUN_SHARDS: number;
export declare function ciShardCount(plan: CiSuitePlan, coverage: boolean): number;
export declare function parseCiShard(value: string | undefined): string | null;
export declare function readPlanFile(text: string): CiSuitePlan;
export declare function ciSuiteArguments(plan: CiSuitePlan, coverage: boolean, shard?: string | null): string[];
export declare function isCategoryMergeToMain(headRef: string | undefined, baseRef: string | undefined): boolean;
export declare function planCiSuite(
  eventName: string | undefined,
  refs?: { headRef?: string; baseRef?: string; ref?: string },
): CiSuitePlan;
