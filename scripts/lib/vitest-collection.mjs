import { posix } from "node:path";

const testFileGlob = "**/*.{test,spec}.{ts,tsx}";
export const baseExclude = [
  "node_modules/**",
  "dist/**",
  "plugins/**",
  ".claude/**",
  "test/e2e/**",
  "test/screenshots/**",
  "**/__tests__/fixtures/**",
];
export const rendererTestGlobs = [
  `test/renderer/${testFileGlob}`,
  `src/ui/__tests__/${testFileGlob}`,
  `src/ui/renderer/__tests__/${testFileGlob}`,
  `src/ui/renderer/**/__tests__/${testFileGlob}`,
];
export const suiteInclude = [
  `src/**/__tests__/${testFileGlob}`,
  `test/${testFileGlob}`,
];

/** Repository-relative path collected by one of the analysis projects. */
export function isCollectedVitestFile(path) {
  return suiteInclude.some(pattern => posix.matchesGlob(path, pattern))
    && !baseExclude.some(pattern => posix.matchesGlob(path, pattern));
}
