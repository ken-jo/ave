import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";

let root: string;
let project: string;
let outside: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "powershell-bindings-")));
  project = join(root, "workspace"); outside = join(root, "external");
  mkdirSync(project); mkdirSync(outside);
  writeFileSync(join(outside, ".env"), "SYNTHETIC=value");
  vi.stubEnv("AVE_HOME", join(root, "profile"));
  symlinkSync(outside, join(project, "junction"), "junction");
  symlinkSync(outside, join(project, "directory-link"), process.platform === "win32" ? "junction" : "dir");
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupTmpDir(root); });

it.each(["-r", "-s", "-Rec", "-Depth 2", "-de 2", "-Depth:2"])("retains escaped targets after the supported parameter %s", (parameter) => {
  for (const command of ["gci", "Get-ChildItem", "ls"]) for (const link of ["junction", "directory-link"]) {
    const evidence = inspectPowerShellPermissionPaths(`${command} ${parameter} '${link}'`, project);
    expect(evidence.paths.some((path) => path.projectEscape && path.canonical === outside), `${command} ${parameter} ${link}`).toBe(true);
  }
});

it("resolves abbreviated named source and destination bindings with their own effects", () => {
  const result = inspectPowerShellPermissionPaths("Copy-Item -Li junction/.env -Dest .GIT/config -Rec", project);
  expect(result.paths.some((path) => path.effect === "read" && path.projectEscape && path.secret !== null)).toBe(true);
  expect(result.paths.some((path) => path.effect === "write" && path.protectedControl === ".git")).toBe(true);
});

it.each(["-LiteralPath", "-Li", "-pAtH"])("retains protected case and separator evidence through %s", (parameter) => {
  const result = inspectPowerShellPermissionPaths(`Get-ChildItem ${parameter} '.GIT\\objects'`, project);
  expect(result.paths.some((path) => path.protectedControl === ".git")).toBe(true);
});

it("keeps a dynamic parameter value uncertain without making it a filesystem target", () => {
  const result = inspectPowerShellPermissionPaths("gci -Depth $limit ordinary", project);
  expect(result.unproven).toBe(true);
  expect(result.paths).toHaveLength(1);
  expect(result.paths[0]).toMatchObject({ canonical: join(project, "ordinary"), projectEscape: false, protectedControl: undefined });
});

it("retains later path candidates when a parameter binding is ambiguous", () => {
  const result = inspectPowerShellPermissionPaths("gci -d 2 junction", project);
  expect(result.unproven).toBe(true);
  expect(result.paths.some((path) => path.projectEscape && path.canonical === outside)).toBe(true);
});

it("keeps quoted flag-like path operands as paths", () => {
  const result = inspectPowerShellPermissionPaths("gci '-r'", project);
  expect(result.paths.some((path) => path.canonical === join(project, "-r"))).toBe(true);
});
