import type { GitRawDiffEntry } from "./hooks/pre-push-ref-updates.mjs";
import type { CiSuitePlan } from "./verify-ci-shard-count.mjs";

export { type CiSuitePlan, readPlanFile } from "./verify-ci-shard-count.mjs";

export const MUST_RUN_TESTS_PATH: string;
export const AFFECTED_TEST_LIMIT: number;

export declare function loadsComputedImport(text: string): boolean;
export declare function namedRepositoryPaths(testPath: string, text: string): string[];
export declare function namesChangedPath(named: string, changedPath: string): boolean;
export declare function expandMustRunTests(document: unknown, trackedTests: readonly string[], changedPaths?: readonly string[]): string[];
export declare function selectCiTests(input: {
  selectCatalog?: (entries: GitRawDiffEntry[]) => { testFiles: string[]; consumerModules: string[]; reason?: undefined } | { reason: string };
  baseRef?: string;
  changes: GitRawDiffEntry[];
  trackedTests: readonly string[];
  mustRunTests: readonly string[];
  readText: (path: string) => string | null;
  discoverRelated: (paths: string[]) => { source: string; tests: string[] }[] | null;
}): CiSuitePlan;
export declare function runsRepoCodeOutOfProcess(text: string): boolean;
export declare function testRunsRepoCodeOutOfProcess(testPath: string, readText: (path: string) => string | null): boolean;
export declare function parseCiShard(value: string | undefined): string | null;
export declare function ciSuiteArguments(plan: CiSuitePlan, coverage: boolean, shard?: string | null): string[];
export declare function isCategoryMergeToMain(headRef: string | undefined, baseRef: string | undefined): boolean;
export declare function planCiSuite(
  eventName: string | undefined,
  refs?: { headRef?: string; baseRef?: string; ref?: string; before?: string },
): CiSuitePlan;

export declare function platformChecksRequired(eventName: string, plan: CiSuitePlan, changes?: readonly GitRawDiffEntry[], baseRef?: string): boolean;
