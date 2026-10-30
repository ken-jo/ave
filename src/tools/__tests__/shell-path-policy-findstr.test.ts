import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectShellPermissionPaths } from "../../permissions/rules/literal-shell-inspection.js";

let project: string;
beforeEach(() => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), "native-search-paths-")));
  mkdirSync(join(project, ".git"));
});
afterEach(() => { rmSync(project, { recursive: true, force: true }); });

it.each([
  "findstr /si term src", "findstr /s/i term src", "findstr /sic:probe src",
  "findstr /s/offline term src", "findstr --% /s term src", "findstr.exe /si term src",
])("retains file reads without inventing a mutation for native search options: %s", command => {
  const result = inspectShellPermissionPaths(command, project);
  expect(result.unknownProtectedWrite).toBeUndefined();
  expect(result.paths.some(path => path.canonical === join(project, "src") && path.effect === "read")).toBe(true);
  expect(result.paths.every(path => path.effect === "read" && path.protectedControl === undefined)).toBe(true);
});

it.each([
  ["findstr /g:patterns.txt src", "patterns.txt"],
  ["findstr /f:files.txt term", "files.txt"],
  ["findstr /d:sub term src", "sub"],
] as const)("keeps file-backed native search options visible as reads: %s", (command, path) => {
  const result = inspectShellPermissionPaths(command, project);
  expect(result.paths.some(fact => fact.canonical === join(project, path) && fact.effect === "read")).toBe(true);
  expect(result.unknownProtectedWrite).toBeUndefined();
});

it("keeps a literal search pattern as data", () => {
  const result = inspectShellPermissionPaths("findstr /c:.git/config src", project);
  expect(result.paths.map(path => path.canonical)).toEqual([join(project, "src")]);
  expect(result.paths[0]!.effect).toBe("read");
});

it("retains an explicit protected output redirection after a native search", () => {
  const result = inspectShellPermissionPaths("findstr /si term src > .git/config", project);
  expect(result.paths.some(path => path.effect === "write" && path.protectedControl === ".git")).toBe(true);
});

it("retains an unresolved output redirection after a native search", () => {
  const result = inspectShellPermissionPaths("findstr /si term src > $TARGET", project);
  expect(result.unknownProtectedWrite).toEqual(expect.any(String));
});
