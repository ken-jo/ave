import "../../__tests__/support/trusted-powershell.js";
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePathForMatch, createPathCanonicalizer } from "../sensitive-paths.js";
import { PermissionManager } from "../permission-manager.js";
import { prepareShellFloorInput } from "../rules/shell-literal-data.js";
import * as shellAnalysis from "../../shared/shell-analysis.js";
import { parseShellSyntax, SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import * as shellFloors from "../rules/shell-exfiltration.js";
import { inspectPowerShellCommand, inspectPowerShellVisibleText, parsePowerShellCommand, _recordPowerShellLexesForTest } from "../rules/powershell-exfiltration.js";
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
      for (const inspect of [shellFloors.inspectShellCommand, inspectPowerShellCommand, inspectPowerShellVisibleText]) expect(inspect(command, CWD)).toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null, ordinaryAsk: SHELL_FLOOR_BUDGET_REASON, analysisLimited: true });
      expect(bash).not.toHaveBeenCalled();
      expect(powershell.lexed).toEqual([]);
    } finally { bash.mockRestore(); powershell.stop(); }
  });

  it("inspects floors beyond the literal-rule cap", () => {
    const command = `# ${"x".repeat(2_100)}\ncat ~/.ssh/id_rsa`;
    expect(shellFloors.inspectShellCommand(command, CWD).sensitive).toContain(".ssh");
    expect(inspectPowerShellCommand(command, CWD).sensitive).toContain(".ssh");
  });

  it("keeps ordinary syntax refusal separate from structural limits", () => {
    for (const inspect of [shellFloors.inspectShellCommand, inspectPowerShellCommand]) {
      const refused = inspect("echo 'unterminated", CWD);
      expect(refused.analysisLimited).toBeUndefined();
      expect(refused.ordinaryAsk).toEqual(expect.any(String));
    }
  });

  it("closes a real parser recursion refusal", () => {
    const depth = Math.min(100, SHELL_ANALYSIS_LIMITS.depth);
    const command = `${"(".repeat(depth)}printf ready${")".repeat(depth)}`;
    expect(shellFloors.inspectShellCommand(command, CWD)).toMatchObject({ analysisLimited: true });
    const directory = mkdtempSync(join(tmpdir(), "shell-floor-limits-"));
    try {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setMode("allow");
      const result = manager.checkDetailed("bash", "builtin", "shell", null, { ruleSubject: { kind: "shell", dialect: "bash", command, cwd: CWD }, shellExecution: { runsSandboxed: true } });
      expect(result).toMatchObject({ decision: "deny", layer: 1, reasonCode: "shell-analysis-limit" });
      expect(result.reason).toMatch(/(?:nesting|recursion|depth|budget|limit)/i);
      expect(result.forceModal).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts literal paths without a speculative operation quota", () => {
    const command = `printf ${Array.from({ length: Math.min(200, MAX_SHELL_ANALYSIS_TOKENS - 1) }, (_, index) => `p${index}`).join(" ")}`;
    expect(shellFloors.inspectShellCommand(command, CWD).analysisLimited).toBeUndefined();
    expect(inspectPowerShellCommand(command, CWD).analysisLimited).toBeUndefined();
  });

  it.each(["wsl ls *.txt", `${"env ".repeat(17)}git status`])("keeps ordinary delegated inspection for %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD).analysisLimited).toBeUndefined();
  });

  it("scans fallback path spans without overlapping source ranges", () => {
    const source = `printf p0 p1 p2 p3; echo 'unterminated`;
    const paths = vi.spyOn(shellFloors, "sensitivePathInArgumentText");
    try {
      expect(inspectPowerShellVisibleText(source, CWD).analysisLimited).toBeUndefined();
      const scanned = paths.mock.calls.map(([text]) => text);
      expect(scanned.reduce((total, text) => total + text.length, 0)).toBeLessThanOrEqual(source.length);
    } finally { paths.mockRestore(); }
  });

  it("counts actual word records rather than whitespace inside a quote", () => {
    const command = `git commit -m '${"word ".repeat(300)}message'`;
    const parsed = shellFloors.parseShellFloorCommand(command);
    expect(parsed.analysis).toMatchObject({ ok: true, totalTokens: 4 });
    expect(parsePowerShellCommand(command).analysisLimited).toBe(false);
  });

  it.each(["; ", " | ", "\n"])("counts all simple commands across %j", (separator) => {
    const groups: string[] = [];
    for (let words = 0; words < MAX_SHELL_ANALYSIS_TOKENS;) {
      const size = Math.min(20, MAX_SHELL_ANALYSIS_TOKENS - words);
      groups.push(":" + " x".repeat(size - 1));
      words += size;
    }
    const commands = groups.join(separator);
    expect(shellFloors.parseShellFloorCommand(commands).analysis.ok).toBe(true);
    expect(shellFloors.inspectShellCommand(`${commands} x`, CWD).analysisLimited).toBe(true);
    expect(parsePowerShellCommand(`${commands}${separator}:`).analysisLimited).toBe(true);
  });

  it("counts nested execution records in the same native cap", () => {
    const command = `echo $(:); ${":;".repeat(MAX_SHELL_ANALYSIS_TOKENS - 3)}`;
    expect(shellFloors.parseShellFloorCommand(command).analysis.ok).toBe(true);
    expect(shellFloors.inspectShellCommand(`${command}:`, CWD).analysisLimited).toBe(true);
  });

  it("retains the total count on already parsed inputs", () => {
    const command = ":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1);
    const parsed = { command, analysis: shellAnalysis.analyzeShell(command), facts: new Map() };
    expect(() => shellFloors.parseShellFloorCommand(parsed)).toThrow();
  });

  it("does not poison subsequent native parsing after a cap refusal", () => {
    expect(() => parseShellSyntax("printf x y", { totalTokens: 2 })).toThrow(/total token limit/);
    expect(shellAnalysis.analyzeShell("printf ready").ok).toBe(true);
  });

  it("reuses the original parsed command without another grammar call", () => {
    const parsed = shellFloors.parseShellFloorCommand("printf ready");
    const parser = vi.spyOn(shellAnalysis, "analyzeShell");
    try {
      expect(shellFloors.parseShellFloorCommand(parsed)).toBe(parsed);
      expect(shellFloors.inspectShellCommand(parsed, CWD).analysisLimited).toBeUndefined();
      expect(parser).not.toHaveBeenCalled();
    } finally { parser.mockRestore(); }
  });

  it("shares the initial dialect lex with inspection and rule proof", () => {
    const recorder = _recordPowerShellLexesForTest();
    try {
      const parsed = parsePowerShellCommand("Write-Output ready");
      expect(inspectPowerShellCommand(parsed, CWD).analysisLimited).toBeUndefined();
      expect(recorder.lexed.filter((command) => command === parsed.command)).toHaveLength(1);
    } finally { recorder.stop(); }
  });

  it("reuses failed ancestor observations across sibling paths", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "floor-path-cache-")));
    try {
      const first = join(directory, "missing", "deeper", "a");
      const second = join(directory, "missing", "deeper", "b");
      const expected = [canonicalizePathForMatch(first), canonicalizePathForMatch(second)];
      const native = vi.spyOn(realpathSync, "native");
      try {
        const canonicalize = createPathCanonicalizer();
        expect(canonicalize(first)).toBe(expected[0]);
        const observed = native.mock.calls.length;
        expect(canonicalize(second)).toBe(expected[1]);
        expect(native).toHaveBeenCalledTimes(observed);
      } finally { native.mockRestore(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains different symlink targets beneath an existing parent", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "floor-link-cache-")));
    try {
      mkdirSync(join(directory, "one")); mkdirSync(join(directory, "two"));
      writeFileSync(join(directory, "one", "file"), "one"); writeFileSync(join(directory, "two", "file"), "two");
      symlinkSync(join(directory, "one"), join(directory, "left"), "junction"); symlinkSync(join(directory, "two"), join(directory, "right"), "junction");
      const canonicalize = createPathCanonicalizer();
      for (const leaf of ["left", "right"]) expect(canonicalize(join(directory, leaf, "file"))).toBe(canonicalizePathForMatch(join(directory, leaf, "file")));
      expect(canonicalize(join(directory, "left", "file"))).not.toBe(canonicalize(join(directory, "right", "file")));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["read HOME", "unset HOME"])("retains runtime-state refusal through quoted data for %s", (mutation) => {
    const suffix = `${mutation}; cd "$HOME"/foo; grep -r x .`;
    const expected = shellFloors.inspectShellCommand(suffix, CWD);
    expect(expected).toMatchObject({ outcome: "unproven", sensitive: null });
    const prepared = prepareShellFloorInput(`cat <<'E'\ndata\nE\n${suffix}`, "bash");
    expect(prepared?.parsed).toBeDefined();
    const actual = shellFloors.inspectShellCommand(prepared!.parsed!, CWD);
    expect(actual.sensitive).toBe(expected.sensitive);
    expect(actual.ordinaryAsk).toBe(expected.ordinaryAsk);
  });

  it("closes unparsed tails over the global visible token cap", () => {
    const command = `echo \0; ${"x ".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1)}`;
    expect(command.length).toBeLessThan(SHELL_FLOOR_INPUT_LIMIT);
    expect(shellFloors.inspectShellCommand(command, CWD).analysisLimited).toBe(true);
    expect(inspectPowerShellVisibleText(command, CWD).analysisLimited).toBe(true);
  });

  it("counts empty assignment declarations rather than treating them as no records", () => {
    const command = "$a=;".repeat(MAX_SHELL_ANALYSIS_TOKENS);
    expect(parsePowerShellCommand(command).analysisLimited).toBe(false);
    expect(parsePowerShellCommand(command + "$a=;").analysisLimited).toBe(true);
  });

  it("preserves a quoted path with spaces during fallback inspection", () => {
    expect(inspectPowerShellVisibleText("echo 'C:/Users/owner/Library/Application Support/Firefox/Profiles/a/logins.json'", CWD).sensitive).not.toBeNull();
  });
});
