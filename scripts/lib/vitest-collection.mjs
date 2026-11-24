import { execFileSync } from "node:child_process";
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

/** Every tracked suite Vitest collects in the checkout at root, sorted. */
export function collectedVitestFiles(root) {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "src", "test"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return tracked.split("\0").filter(path => path && isCollectedVitestFile(path)).sort();
}
