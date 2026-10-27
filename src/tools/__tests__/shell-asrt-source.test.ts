import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

// Check plan sealing and permit consumption in each dialect so one implementation cannot mask the other's gap.
const shellTools = readRepoFile("src/tools/shell-tools.ts");
const powershellSectionStart = shellTools.indexOf(" * Native PowerShell tool.");
const bashSection = shellTools.slice(0, powershellSectionStart);
const powershellSection = shellTools.slice(powershellSectionStart);

function expectShellDialectContracts(section: string, dialect: "bash" | "powershell"): void {
  expect(section).toContain("const suppliedHostShellPlan = ctx.hostShellExecutionPlan");
  expect(section).toContain("isIssuedHostShellExecutionPlan(suppliedHostShellPlan)");
  expect(section).toContain("consumeHostShellExecutionPermit");
  expect(section).toContain(dialect === "powershell"
    ? 'requiresExplicitHostShellApproval(hostShellPlan, "powershell")'
    : "requiresExplicitHostShellApproval(hostShellPlan)");
  expect(section).toContain('hostShellPlan.mode === "blocked"');
  expect(section).toContain('hostShellPlan.mode === "asrt"');
  expect(section).toContain("shell: false");
  expect(section).toContain("const { allowRead, denyRead, floorPierces } = getBuiltinShellReadPolicy(");
  // Saved-session reads pierce the protected floor only when the shell explicitly requests them.
  expect(section).toContain("    floorPierces,\n  };");
  expect(section).toContain("denyWrite: getDefaultSensitiveWriteDenyPaths()");
}

describe("shell ASRT source contracts", () => {
  it("the bash sections verify an issued plan and consume a generic one-shot fallback permit", () => {
    expect(powershellSectionStart).toBeGreaterThan(0);
    expectShellDialectContracts(bashSection, "bash");
  });

  it("the powershell sections verify an issued plan and consume a generic one-shot fallback permit", () => {
    expectShellDialectContracts(powershellSection, "powershell");
  });
});

describe("background shell lifetime contract", () => {
  // Background processes are managed children killed at shutdown; model-facing descriptions must disclose that lifetime.
  it("registers the background child with the managed-child registry", () => {
    expect(bashSection).toMatch(/trackManagedChildProcess\(child,\s*\{\s*label:\s*"tool:bash:background",\s*killProcessGroup,?\s*\}\)/);
    expect(bashSection).toContain('spawnWindowsJobProcess(shell.cmd, [...argv], { cwd, env })');
    expect(bashSection).toContain("detached: true");
    expect(bashSection).toContain('killProcessGroup: process.platform !== "win32"');
  });

  it("states the lifetime in the parameter the model chooses from", () => {
    expect(bashSection).toContain("The shell is bound to this session and is ");
    expect(bashSection).toContain("terminated when the session ends");
  });

  it("states the lifetime again in the result the model reads back", () => {
    expect(bashSection).toContain("This shell is managed by the session and is stopped when the session ends.");
    expect(bashSection).toContain("Descendants that leave the owned process group may survive its cleanup.");
  });
});
