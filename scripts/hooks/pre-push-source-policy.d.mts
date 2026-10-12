export interface PrePushChange {
  status: string;
  path: string;
  oldMode: string;
  newMode: string;
}

export const AVE_APP_LOCK_SUITES: readonly string[];
export const FULL_CHECK_GLOBAL_INPUT_FILES: readonly string[];
export function isFullCheckGlobalInput(relativePath: string): boolean;
export function getRelatedCoverageFullReason(relatedFiles: string[], coverage: unknown): string | null;
export function selectFastSourceChecks<T extends PrePushChange>(changes: T[]): {
  eligible: boolean;
  reason: string;
  testFiles: string[];
  relatedFiles: string[];
  documentationEntries: T[];
};
