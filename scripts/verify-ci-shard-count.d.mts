import type { GitRawDiffEntry } from "./hooks/pre-push-ref-updates.mjs";

export interface CiSuitePlan {
  mode: "full" | "affected";
  reason: string;
  tests: string[];
  testOnlyFiles?: string[];
  testOnlyChanges?: GitRawDiffEntry[];
}

export const FULL_RUN_SHARDS: number;
export declare function ciShardCount(plan: CiSuitePlan, coverage: boolean, nativeChecks?: boolean): number;
export declare function validateCiShardCount(
  plan: CiSuitePlan,
  coverage: boolean,
  nativeChecks: boolean,
  reportedCount: string | undefined,
): void;
export declare function readPlanFile(text: string, root?: string): CiSuitePlan;
export declare function runsCoverage(eventName: string | undefined, plan: CiSuitePlan): boolean;
