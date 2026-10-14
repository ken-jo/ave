export interface PrePushChange {
  status: string;
  path: string;
  oldMode: string;
  newMode: string;
}

export const AVE_APP_LOCK_SUITE_TRIGGERS: Readonly<Record<string, readonly string[]>>;
export const AVE_APP_LOCK_SUITES: readonly string[];
export const FULL_CHECK_GLOBAL_INPUT_FILES: readonly string[];
export const RELATED_TEST_BOUND: number;
export function isFullCheckGlobalInput(relativePath: string): boolean;
export function selectTriggeredLockSuites(changedPaths: readonly string[]): { suite: string; path: string }[];
export function getRelatedCoverageFullReason(relatedFiles: string[], coverage: unknown): string | null;
export function boundRelatedTests(
  coverage: { source: string; tests: string[] }[],
  readText: (path: string) => string | null,
):
  | { tests: string[]; narrowed: { source: string; related: number; direct: number }[]; reason?: undefined }
  | { reason: string; tests?: undefined; narrowed?: undefined };
export function selectFastSourceChecks<T extends PrePushChange>(changes: T[]): {
  eligible: boolean;
  reason: string;
  testFiles: string[];
  relatedFiles: string[];
  documentationEntries: T[];
};
