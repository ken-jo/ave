import type { PrePushChange } from "./pre-push-source-policy.mjs";

export function selectPrePushRegressionTests(changedPaths: readonly string[]): string[];

export function selectTargetedAveAppVitestFiles(changes: PrePushChange[]): {
  eligible: boolean;
  reason: string;
  files: string[];
  supportFiles: string[];
  supportTestFiles: string[];
};
