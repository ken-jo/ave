import { describe, expect, it } from "vitest";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { POWERSHELL_FILE_TYPES } from "../rules/powershell-file-provenance.js";
import { hiddenCodeReason, refusedShellPrefix, SHELL_PREFIX_POLICY } from "../rules/shell-prefix-policy.js";

const CWD = "/work/project";
const RUNNERS = [
  "npm.ps1 test", "pnpm.ps1 test", "yarn.ps1 test", "npx.ps1 test",
  "npm.psm1 test", "NPM.PS1 test", "npm.ps1. test",
  "corepack pnpm test", "corepack yarn test", "yarnpkg test", "deno task test",
  "corepack.ps1 pnpm test", "yarnpkg.ps1 test", "deno.ps1 task test",
];

describe("package runner shims and dispatchers", () => {
  it.each(SHELL_PREFIX_POLICY.packageRunners)("keeps bare %s subject to intrinsic code checks only", (runner) => {
    const result = inspectPowerShellCommand(runner, CWD);
    expect(hiddenCodeReason([runner])).toBe(runner === "deno" ? "deno reads code from stdin" : null);
    expect(result).toEqual({
      sensitive: null,
      exfiltration: runner === "deno" ? "PowerShell hidden code (runtime script)" : null,
    });
    expect(refusedShellPrefix([runner])).not.toBeNull();
  });

  it.each(SHELL_PREFIX_POLICY.packageRunners)("requires approval for bare %s after materialization", (runner) => {
    expect(inspectPowerShellCommand(`Set-Content package.json x; ${runner}`, CWD).exfiltration)
      .toContain("materialized task input");
  });

  it.each(RUNNERS.flatMap((runner) => [
    `Set-Content package.json x; ${runner}`,
    `Set-Content payload.ps1 Get-Date; ${runner}`,
  ]))("requires approval after a file write: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toContain("materialized task input");
  });

  it.each(RUNNERS)("retains normal flow without a file write: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toEqual({ sensitive: null, exfiltration: null });
  });

  it.each([
    "npm.ps1 --version", "corepack --version", "yarnpkg --help", "deno --version",
  ])("retains exact informational arguments after a write: %s", (runner) => {
    expect(inspectPowerShellCommand(`Set-Content package.json x; ${runner}`, CWD))
      .toEqual({ sensitive: null, exfiltration: null });
  });

  it.each(["npm.ps1 --version", "corepack --version", "yarnpkg --help", "deno --version"])
  ("requires approval when the informational runner itself was written: %s", (runner) => {
    const executable = runner.split(" ")[0]!;
    expect(inspectPowerShellCommand(`Set-Content ${executable} Get-Date; ${runner}`, CWD).exfiltration)
      .toContain("materialized file");
  });

  it.each(Object.entries(POWERSHELL_FILE_TYPES).filter(([extension, type]) => extension && type !== "document").map(([extension]) => extension))
  ("recognizes the materialized runner through catalogued extension %s", (extension) => {
    expect(inspectPowerShellCommand(`Set-Content package.json x; npm${extension} test`, CWD).exfiltration)
      .toContain("materialized task input");
  });

  it.each(["npm.bat test", "npm.cmd test", "npm.exe test"])
  ("retains the existing opaque executable check without a write: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toContain("opaque executable file payload");
  });

  it("does not treat a document suffix as a runner shim", () => {
    expect(inspectPowerShellCommand("Set-Content package.json x; npm.txt test", CWD).exfiltration)
      .toContain("opaque executable file payload");
  });

  it.each([
    ["corepack", ["corepack", "pnpm", "test"]],
    ["yarnpkg", ["yarnpkg", "test"]],
    ["deno", ["deno", "task", "test"]],
  ] as const)("shares runner %s while preserving understood task prefixes", (name, argv) => {
    expect(SHELL_PREFIX_POLICY.packageRunners).toContain(name);
    expect(refusedShellPrefix(argv)).toBeNull();
    expect(hiddenCodeReason(argv)).toBeNull();
  });

  it.each([
    ["corepack", "package-runner"], ["yarnpkg", "package-runner"], ["deno", "interpreter"],
  ] as const)("keeps an unconstrained prefix for %s out of persistent rules", (name, reason) => {
    expect(refusedShellPrefix([name])).toBe(reason);
  });
});
