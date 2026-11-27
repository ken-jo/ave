export interface CiSuitePlan {
  mode: "full" | "affected";
  reason: string;
  tests: string[];
}

export const FULL_RUN_SHARDS: number;
export declare function ciShardCount(plan: CiSuitePlan, coverage: boolean, nativeChecks?: boolean): number;
export declare function validateCiShardCount(
  plan: CiSuitePlan,
  coverage: boolean,
  nativeChecks: boolean,
  reportedCount: string | undefined,
): void;
export declare function readPlanFile(text: string): CiSuitePlan;
export declare function runsCoverage(eventName: string | undefined, plan: CiSuitePlan): boolean;
