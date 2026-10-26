import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePathForMatch } from "../sensitive-paths.js";
import { PermissionManager } from "../permission-manager.js";
import { ShellFloorWorkBudget, SHELL_FLOOR_WORK_LIMITS } from "../rules/shell-floor-work-budget.js";
import * as shellAnalysis from "../../shared/shell-analysis.js";
import { parseShellSyntax, SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
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

  it.each(["wsl ls *.txt", `${"env ".repeat(17)}git status`])("does not charge delegated analysis for work it did not perform in %s", (command) => {
    const result = _inspectPowerShellForTest(command, CWD);
    expect(result.exhausted).toBe(false);
    expect(result.analysisLimited).toBeUndefined();
    expect(result.ordinaryAsk).not.toBe(SHELL_FLOOR_BUDGET_REASON);
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

  it("charges the characters actually inspected, preserving spaces inside quoted data", () => {
    const source = `git commit -m '${"short ".repeat(245)}message'`;
    const budget = new ShellFloorWorkBudget();
    expect(shellFloors.parseShellFloorCommand(source, budget).analysis.ok).toBe(true);
    expect(budget.exhausted).toBe(false);
    expect(budget.steps).toBeLessThan(source.length * 4);
  });

  it("bounds emitted command records independently of spaces inside quoted words", () => {
    for (const quoted of [false, true]) {
      const source = `printf ${Array.from({ length: SHELL_FLOOR_WORK_LIMITS.commandTokens - 1 }, () => quoted ? "'two words'" : "word").join(" ")}`;
      const budget = new ShellFloorWorkBudget();
      expect(shellFloors.parseShellFloorCommand(source, budget).analysis.ok).toBe(true);
      expect(() => shellFloors.parseShellFloorCommand(source + " another", new ShellFloorWorkBudget())).toThrow();
    }
  });

  it("resets command token records at pipeline and statement boundaries", () => {
    const stage = "printf " + "word ".repeat(SHELL_FLOOR_WORK_LIMITS.commandTokens - 1);
    for (const separator of [" | ", "; ", "\n"]) {
      const source = stage + separator + stage;
      expect(shellFloors.parseShellFloorCommand(source, new ShellFloorWorkBudget()).analysis.ok).toBe(true);
      expect(inspectPowerShellCommand(source, CWD).analysisLimited).toBeUndefined();
    }
  });

  it("propagates exhausted path work without retrying the filesystem walk", () => {
    const spent = new Error("spent work");
    const charge = vi.fn(() => { throw spent; });
    expect(() => canonicalizePathForMatch("/not-a-real-root/not-a-real-file", charge)).toThrow(spent);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("charges the actual native lexer count without a second source reader", () => {
    const source = "printf 'one two three'";
    const count = vi.fn();
    parseShellSyntax(source, { commandWords: 64, lexerSteps: 16_384, onLexerSteps: count });
    const budget = new ShellFloorWorkBudget();
    expect(shellFloors.parseShellFloorCommand(source, budget).analysis.ok).toBe(true);
    expect(count).toHaveBeenCalledTimes(1);
    expect(budget.steps).toBe(count.mock.calls[0]![0]);
    expect(budget.chars).toBe(source.length);
  });

  it("charges actual lexer work for syntax refusal and for successful parsing", () => {
    for (const command of ["printf '" + "word ".repeat(900), "printf '" + "word ".repeat(900) + "'"]) {
      const budget = new ShellFloorWorkBudget();
      const result = shellFloors.parseShellFloorCommand(command, budget);
      expect(result.analysis.ok).toBe(command.endsWith("'"));
      expect(budget.steps).toBeGreaterThan(4_000);
      expect(budget.exhausted).toBe(false);
    }
  });

  it("charges failed parsing against remaining work without poisoning later parses", () => {
    const command = "printf '" + "word ".repeat(900);
    const count = vi.fn();
    expect(() => parseShellSyntax(command, { commandWords: 64, lexerSteps: 16_384, onLexerSteps: count })).toThrow(/without closing quote/);
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0]![0]).toBeGreaterThan(4_000);
    const budget = new ShellFloorWorkBudget();
    budget.enterSource(command);
    budget.spend(command.length * SHELL_FLOOR_WORK_LIMITS.stepsPerChar - 2);
    expect(() => shellFloors.parseShellFloorCommand(command, budget)).toThrow();
    expect(budget.exhausted).toBe(true);
    const spent = new Error("caller spent after refusal");
    expect(() => parseShellSyntax(command, { commandWords: 64, lexerSteps: 16_384, onLexerSteps: () => { throw spent; } })).toThrow(spent);
    expect(shellAnalysis.analyzeShell("printf ready").ok).toBe(true);
  });

  it("keeps native lexer refusal and caller exhaustion separate from runtime integrity", () => {
    expect(() => parseShellSyntax("printf ready", { commandWords: 64, lexerSteps: 1 })).toThrow(/lexer work limit/);
    const spent = new Error("caller budget spent");
    expect(() => parseShellSyntax("printf ready", { commandWords: 64, lexerSteps: 16_384, onLexerSteps: () => { throw spent; } })).toThrow(spent);
    expect(shellAnalysis.analyzeShell("printf ready").ok).toBe(true);
  });

  it.each([
    "cat <<'EOF'\nbody\nEOF\n" + "printf " + "word ".repeat(64),
    "cat <<< data\n" + "printf " + "word ".repeat(64),
    "printf " + "word ".repeat(40) + "$(printf x) " + "word ".repeat(40),
  ])("uses each original command's records through redirects and substitutions: %s", (command) => {
    const analysis = shellAnalysis.analyzeShell(command);
    expect(analysis.ok).toBe(true);
    expect(() => shellFloors.parseShellFloorCommand(command, new ShellFloorWorkBudget())).toThrow();
    const parsed = { command, analysis, facts: new Map() };
    expect(() => shellFloors.parseShellFloorCommand(parsed, new ShellFloorWorkBudget())).toThrow();
  });

  it("reuses the parsed command without charging its source twice", () => {
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
