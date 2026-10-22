import type { GitRawDiffEntry } from "./hooks/pre-push-ref-updates.mjs";

export const MUST_RUN_TESTS_PATH: string;
export const AFFECTED_TEST_LIMIT: number;

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
  changes: GitRawDiffEntry[];
  trackedTests: readonly string[];
  mustRunTests: readonly string[];
  readText: (path: string) => string | null;
  discoverRelated: (paths: string[]) => { source: string; tests: string[] }[] | null;
}): CiSuitePlan;
export declare function runsRepoCodeOutOfProcess(text: string): boolean;
export declare function testRunsRepoCodeOutOfProcess(testPath: string, readText: (path: string) => string | null): boolean;
export declare function isCategoryMergeToMain(headRef: string | undefined, baseRef: string | undefined): boolean;
export declare function planCiSuite(
  eventName: string | undefined,
  refs?: { headRef?: string; baseRef?: string },
): CiSuitePlan;
