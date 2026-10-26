import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { ShellFloorWorkBudget, SHELL_FLOOR_WORK_LIMITS } from "../rules/shell-floor-work-budget.js";
import * as shellAnalysis from "../../shared/shell-analysis.js";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import * as shellFloors from "../rules/shell-exfiltration.js";
import { inspectPowerShellCommand, inspectPowerShellVisibleText, _inspectPowerShellForTest, _recordPowerShellLexesForTest } from "../rules/powershell-exfiltration.js";
import { SHELL_FLOOR_BUDGET_REASON, SHELL_FLOOR_INPUT_LIMIT, shellFloorInputExceeded } from "../rules/shell-floor-policy.js";

const CWD = "/work/project";

describe("bounded visible floor inspection", () => {
  it("uses an independent floor input bound", () => {
    expect(shellFloorInputExceeded("x".repeat(SHELL_FLOOR_INPUT_LIMIT))).toBe(false);
    expect(shellFloorInputExceeded({ command: "x".repeat(SHELL_FLOOR_INPUT_LIMIT + 1) })).toBe(true);
  });

  it("refuses oversized inputs before any floor parse", () => {
    const command = `printf ${"data/path ".repeat(1_000)}`;
    const bash = vi.spyOn(shellAnalysis, "analyzeShell");
    const powershell = _recordPowerShellLexesForTest();
    try {
      for (const inspect of [shellFloors.inspectShellCommand, inspectPowerShellCommand, inspectPowerShellVisibleText]) {
        expect(inspect(command, CWD)).toEqual({ sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true });
      }
      expect(bash).not.toHaveBeenCalled();
      expect(powershell.lexed).toEqual([]);
      expect(shellFloors.sensitivePathInArgumentText(command, CWD)).toBe(SHELL_FLOOR_BUDGET_REASON);
    } finally {
      bash.mockRestore();
      powershell.stop();
    }
  });

  it("inspects floors beyond the literal-rule cap", () => {
    const command = `# ${"x".repeat(2_100)}\ncat ~/.ssh/id_rsa`;
    expect(shellFloors.inspectShellCommand(command, CWD).sensitive).toContain(".ssh");
    expect(inspectPowerShellCommand(command, CWD).sensitive).toContain(".ssh");
  });

  it("distinguishes actual internal exhaustion from ordinary parse refusal", () => {
    const command = `Get-Content (${"'a' + ".repeat(700)}'b')`;
    const spent = _inspectPowerShellForTest(command, CWD);
    expect(spent).toMatchObject({ analysisLimited: true, exhausted: true, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON });
    for (const inspect of [shellFloors.inspectShellCommand, inspectPowerShellCommand]) {
      const refused = inspect("echo 'unterminated", CWD);
      expect(refused.analysisLimited).toBeUndefined();
      expect(refused.ordinaryAsk).toEqual(expect.any(String));
    }
  });

  it("treats a real shell parser recursion limit as spent floor work", () => {
    const depth = Math.min(100, SHELL_ANALYSIS_LIMITS.depth);
    const command = `${"(".repeat(depth)}printf ready${")".repeat(depth)}`;
    expect(command.length).toBeLessThan(SHELL_FLOOR_INPUT_LIMIT);
    expect(shellAnalysis.analyzeShell(command)).toMatchObject({ ok: false, reason: expect.stringMatching(/^\d+:\d+: shell parser recursion limit exceeded$/) });
    expect(shellFloors.inspectShellCommand(command, CWD)).toEqual({ sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true });
    const directory = mkdtempSync(join(tmpdir(), "shell-floor-budget-"));
    try {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setMode("allow");
      manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
      expect(manager.checkDetailed("bash", "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect: "bash", command, cwd: CWD },
        shellExecution: { runsSandboxed: true },
      })).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports spent path work independently of sensitive evidence", () => {
    const command = `printf ${Array.from({ length: 600 }, (_, index) => `data/path${index}`).join(" ")}`;
    expect(command.length).toBeLessThanOrEqual(SHELL_FLOOR_INPUT_LIMIT);
    expect(shellFloors.inspectShellCommand(command, CWD)).toMatchObject({ analysisLimited: true, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON });
  });

  it.each(["wsl ls *.txt", `${"env ".repeat(17)}git status`])("marks real exhaustion separately from opacity in %s", (command) => {
    expect(_inspectPowerShellForTest(command, CWD)).toMatchObject({ analysisLimited: true, exhausted: true, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON });
  });

  it("scans fallback path spans without overlapping source ranges", () => {
    const source = `printf ${Array.from({ length: 4 }, (_, index) => `data/path${index}`).join(" ")}; echo 'unterminated`;
    const paths = vi.spyOn(shellFloors, "sensitivePathInArgumentText");
    try {
      const signals = inspectPowerShellVisibleText(source, CWD);
      expect(signals.analysisLimited).toBeUndefined();
      const scanned = paths.mock.calls.map(([text]) => text);
      expect(scanned.length).toBeGreaterThan(1);
      expect(scanned.reduce((total, text) => total + text.length, 0)).toBeLessThanOrEqual(source.length);
      expect(scanned.filter((text) => text.startsWith("data/path"))).toHaveLength(4);
    } finally { paths.mockRestore(); }
  });

  it("stops fallback before completing the path pass when shared work is spent", () => {
    const source = `printf ${Array.from({ length: 80 }, (_, index) => `data/path${index}`).join(" ")}; echo 'unterminated`;
    const paths = vi.spyOn(shellFloors, "sensitivePathInArgumentText");
    try {
      expect(inspectPowerShellVisibleText(source, CWD)).toMatchObject({ analysisLimited: true });
      expect(paths.mock.calls.length).toBeLessThan(80);
    } finally { paths.mockRestore(); }
  });

  it("keeps a spent budget closed across later analyses without parsing again", () => {
    const budget = new ShellFloorWorkBudget();
    budget.spend(SHELL_FLOOR_WORK_LIMITS.steps - 1);
    expect(shellFloors.inspectShellCommand("printf ready", CWD, budget)).toMatchObject({ analysisLimited: true });
    expect(budget.exhausted).toBe(true);
    const bash = vi.spyOn(shellAnalysis, "analyzeShell");
    const powershell = _recordPowerShellLexesForTest();
    try {
      expect(shellFloors.inspectShellCommand("printf later", CWD, budget)).toMatchObject({ analysisLimited: true });
      expect(inspectPowerShellCommand("Write-Output later", CWD, budget)).toMatchObject({ analysisLimited: true });
      expect(bash).not.toHaveBeenCalled();
      expect(powershell.lexed).toEqual([]);
    } finally { bash.mockRestore(); powershell.stop(); }
  });

  it("reserves syntax materialization before invoking the native parser", () => {
    const source = `printf ${Array.from({ length: 300 }, (_, index) => `p${index}`).join(" ")}`;
    expect(source.length).toBeLessThan(2_000);
    const parser = vi.spyOn(shellAnalysis, "analyzeShell");
    const budget = new ShellFloorWorkBudget();
    try {
      expect(() => shellFloors.parseShellFloorCommand(source, budget)).toThrow();
      expect(budget.exhausted).toBe(true);
      expect(parser).not.toHaveBeenCalled();
    } finally { parser.mockRestore(); }
  });

  it("reuses the reserved parsed command without charging its source twice", () => {
    const budget = new ShellFloorWorkBudget();
    const parsed = shellFloors.parseShellFloorCommand("printf ready", budget);
    const before = { steps: budget.steps, chars: budget.chars };
    const parser = vi.spyOn(shellAnalysis, "analyzeShell");
    try {
      expect(shellFloors.parseShellFloorCommand(parsed, budget)).toBe(parsed);
      expect({ steps: budget.steps, chars: budget.chars }).toEqual(before);
      expect(parser).not.toHaveBeenCalled();
      expect(shellFloors.inspectShellCommand(parsed, CWD, budget).analysisLimited).toBeUndefined();
      expect(parser).not.toHaveBeenCalled();
    } finally { parser.mockRestore(); }
  });

  it("shares the same work object with delegated native inspection", () => {
    const budget = new ShellFloorWorkBudget();
    const delegated = vi.spyOn(shellFloors, "inspectShellCommand");
    try {
      inspectPowerShellCommand("python -c 'print(1)'", CWD, budget);
      expect(delegated).toHaveBeenCalled();
      expect(delegated.mock.calls.every(([, , work]) => work === budget)).toBe(true);
      expect(budget.steps).toBeGreaterThan(0);
    } finally { delegated.mockRestore(); }
  });

  it("preserves a quoted path with spaces during fallback inspection", () => {
    expect(inspectPowerShellVisibleText("echo 'C:/Users/owner/Library/Application Support/Firefox/Profiles/a/logins.json'", CWD).sensitive).not.toBeNull();
  });
});
