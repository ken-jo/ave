import type { PrePushChange } from "./pre-push-source-policy.mjs";

export const FAST_TIER: "fast";
export const GLOBAL_INPUT_TIER: "global-input";
export const FULL_SUITE_DEFERRED: "full suite deferred to CI";
export const FROZEN_LOCKFILE_ARGS: readonly string[];

export function selectScopedTier<T extends PrePushChange>(entries: T[], unresolvedReasons?: readonly string[]): {
  tier: "fast" | "global-input";
  reason: string;
  reasons: string[];
  testFiles: string[];
  relatedFiles: string[];
  messageCatalogEntries: T[];
  documentationEntries: T[];
  namedPaths: string[];
};
export function selectNamedPathTests(
  paths: readonly string[],
  trackedTests: readonly string[],
  readText: (relativePath: string) => string | null,
): string[];
export function selectUntestedModuleTests(
  module: string,
  namedTests: readonly string[],
  mustRunDocument: unknown,
  trackedTests: readonly string[],
): {
  module: string;
  namedTests: string[];
  mustRunTests: string[];
  lockSuites: string[];
  untested: boolean;
};
export function selectUnattributedCatalogChecks<T extends PrePushChange & { baseSha: string; localSha: string }>(
  entries: T[],
  sources: {
    readBlob: (sha: string, relativePath: string) => string | null;
    trackedFiles: readonly string[];
    readTrackedFile: (relativePath: string) => string | null;
  },
): {
  namespaces: string[];
  unattributedFiles: string[];
  testFiles: string[];
  consumerModules: string[];
  skippedConsumers: string[];
};
export function describeScopedTier(options: { tier: string; runs: string; reason: string }): string;
