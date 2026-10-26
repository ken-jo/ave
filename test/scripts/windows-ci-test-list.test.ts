/** Windows-only test cases run in CI only when their file is named in the Windows permission job (.github/workflows/ci.yml); the Linux and macOS shards skip them. A file that gates
 * cases on win32 but is missing from that list never runs anywhere, so this pins the list against the tree. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const STEP_NAME = "Run Windows permission regressions";
const TEST_FILE_RE = /\.test\.tsx?$/;
const SELF = "test/scripts/windows-ci-test-list.test.ts";
// A case or suite that runs only on win32: `runIf(process.platform === "win32")`, `skipIf(process.platform !== "win32")`, or the same through a boolean named for Windows.
const WINDOWS_GATE_RE =
  /\b(?:runIf\(\s*process\.platform\s*===\s*["']win32["']|skipIf\(\s*process\.platform\s*!==\s*["']win32["']|runIf\(\s*(?:isWindows|IS_WINDOWS|isWin32|windows|onWindows)\s*\)|skipIf\(\s*!\s*(?:isWindows|IS_WINDOWS|isWin32|windows|onWindows)\s*\))/;

function windowsJobFiles(): string[] {
  const lines = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
  if (start < 0) throw new Error(`ci.yml has no "${STEP_NAME}" step`);
  const files: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s/.test(line)) break;
    const token = line.trim();
    if (TEST_FILE_RE.test(token)) files.push(token);
  }
  return files;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return testFiles(path);
    return TEST_FILE_RE.test(name) ? [relative(root, path).split("\\").join("/")] : [];
  });
}

describe("Windows CI test list", () => {
  const listed = windowsJobFiles();

  it("names only files that exist", () => {
    expect(listed.filter((file) => !testFiles(join(root, file.split("/")[0]!)).includes(file))).toEqual([]);
  });

  it("names every file with win32-only cases", () => {
    const gated = ["src", "test"].flatMap((dir) => testFiles(join(root, dir))).filter((file) => file !== SELF && (WINDOWS_GATE_RE.test(readFileSync(join(root, file), "utf8")) || file.endsWith(".windows.test.ts")));
    expect(gated.filter((file) => !listed.includes(file)).sort()).toEqual([]);
  });
});
