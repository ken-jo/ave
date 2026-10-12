import type { PrePushChange } from "./pre-push-source-policy.mjs";

export function selectTargetedAveAppVitestFiles(changes: PrePushChange[]): {
  eligible: boolean;
  reason: string;
  files: string[];
  supportFiles: string[];
  supportTestFiles: string[];
};
