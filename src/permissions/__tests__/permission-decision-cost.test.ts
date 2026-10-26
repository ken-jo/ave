import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { permissionDecisionCostTargetMs } from "../../__tests__/support/permission-decision-cost.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { parseShellFloorCommand } from "../rules/shell-exfiltration.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

let cwd: string;
let stateRoot: string;
let manager: PermissionManager;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "decision-cost-")));
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "decision-cost-state-")));
  vi.stubEnv("AVE_HOME", stateRoot);
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(stateRoot, "permissions.json"));
  manager.setMode("allow");
});

afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function commandWithDistinctPaths(length: number): string {
  let command = "cd a0; cd a1; cd a2; cd a3; ";
  let index = 0;
  while (command.length < length) {
    command += "printf %s";
    for (let word = 0; word < 40 && command.length < length; word += 1) {
      command += ` ./p${(index++).toString(36)}`;
    }
    command += "; ";
  }
  return command.slice(0, length);
}

const PLAIN_COMMAND = commandWithDistinctPaths(7_900);
const LARGE_COMMAND = `cat <<'EOF'\n${"x".repeat(59_999)}\nEOF\n${PLAIN_COMMAND}`;

function commandWithWords(words: number, length: number): string {
  let command = "cd a0; cd a1; cd a2; cd a3; ";
  let count = 8;
  let index = 0;
  while (count < words) {
    if (words - count === 1) {
      command += ":; ";
      count += 1;
    } else {
      command += "printf %s";
      count += 2;
      for (let word = 0; word < 40 && count < words; word += 1) {
        command += ` ./p${(index++).toString(36)}`;
        count += 1;
      }
      command += "; ";
    }
  }
  if (command.length > length) throw new Error("Word-count fixture exceeds its character bound");
  return `${command.slice(0, -2)}${"x".repeat(length - command.length)}; `;
}

function quotedData(command: string, bytes: number): string {
  return `cat <<'EOF'\n${"x".repeat(bytes - 1)}\nEOF\n${command}`;
}

function pipelineCommand(stages: number, length: number): string {
  const command = Array.from({ length: stages }, () => "printf %s x x").join(" | ");
  if (command.length > length) throw new Error("Pipeline fixture exceeds its character bound");
  return `${command}${"x".repeat(length - command.length)}`;
}

interface TimingCase {
  name: string;
  command: string;
  dialect: "bash" | "powershell";
  runsSandboxed: boolean;
  allowed: boolean;
  words?: number;
  executableChars: number;
  dataBytes?: number;
}

const CASES: readonly TimingCase[] = [
  { name: "plain", command: PLAIN_COMMAND, dialect: "bash", runsSandboxed: true, allowed: false, executableChars: 7_900 },
  { name: "quoted-data", command: LARGE_COMMAND, dialect: "bash", runsSandboxed: true, allowed: false, executableChars: 7_916, dataBytes: 60_000 },
  ...(["bash", "powershell"] as const).flatMap((dialect) => [false, true].map((runsSandboxed) => ({
    name: `max-${dialect}-${runsSandboxed ? "sandboxed" : "unsandboxed"}`,
    command: commandWithDistinctPaths(runsSandboxed ? 8_000 : 2_000), dialect, runsSandboxed, allowed: false,
    executableChars: runsSandboxed ? 8_000 : 2_000,
  }))),
  { name: "max-quoted-data", command: quotedData(commandWithDistinctPaths(7_984), 65_536), dialect: "bash", runsSandboxed: true, allowed: false, executableChars: 8_000, dataBytes: 65_536 },
  { name: "admitted-token-cap", command: commandWithWords(MAX_SHELL_ANALYSIS_TOKENS, 8_000), dialect: "bash", runsSandboxed: true, allowed: false, executableChars: 8_000, words: MAX_SHELL_ANALYSIS_TOKENS },
  { name: "admitted-token-cap-data", command: quotedData(commandWithWords(MAX_SHELL_ANALYSIS_TOKENS - 2, 7_984), 65_536), dialect: "bash", runsSandboxed: true, allowed: false, executableChars: 8_000, dataBytes: 65_536, words: MAX_SHELL_ANALYSIS_TOKENS },
  { name: "admitted-pipeline", command: pipelineCommand(100, 8_000), dialect: "bash", runsSandboxed: true, allowed: true, executableChars: 8_000, words: 400 },
];

describe("bounded complete decision cost", () => {
  it.each(CASES)("$name", ({ name, command, dialect, runsSandboxed, allowed, words, executableChars, dataBytes }) => {
    expect(command.length).toBe(executableChars + (dataBytes ?? 0));
    const samples: number[] = [];
    const results = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const start = performance.now();
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
      samples.push(performance.now() - start);
      results.push(result);
    }
    const median = [...samples].sort((left, right) => left - right)[1]!;
    process.stdout.write(`decision cost ${JSON.stringify({ name, dialect, lane: runsSandboxed ? "A" : "B", chars: command.length, executableChars, dataBytes, words, samples, median, target: permissionDecisionCostTargetMs, results: results.map(({ decision, layer, forceModal }) => ({ decision, layer, forceModal: forceModal === true })) })}\n`);
    for (const result of results) expect(result).toMatchObject(allowed
      ? { decision: "allow", layer: 3 }
      : { decision: "ask", layer: 2, forceModal: true });
    expect(median).toBeLessThan(permissionDecisionCostTargetMs);
  }, 60_000);

  it.each([false, true])("counts records across command boundaries nested=%s", (nested) => {
    const prefix = nested ? "echo $(:); " : "";
    const prefixWords = nested ? 3 : 0;
    const command = `${prefix}${":;".repeat(MAX_SHELL_ANALYSIS_TOKENS - prefixWords)}`;
    expect(parseShellFloorCommand(command).analysis.ok).toBe(true);
    expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true)).toMatchObject(nested
      ? { decision: "ask", layer: 2, forceModal: true } : { decision: "allow", layer: 3 });
    expect(checkShellPermission(manager, cwd, SESSION_ID, `${command}:`, "bash", true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it("counts assignment values across the complete command", () => {
    const command = "A=1;".repeat(MAX_SHELL_ANALYSIS_TOKENS);
    expect(parseShellFloorCommand(command).analysis.ok).toBe(true);
    expect(parseShellFloorCommand(`${command}A=1`).analysis.ok).toBe(false);
    expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(checkShellPermission(manager, cwd, SESSION_ID, `${command}A=1`, "bash", true)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
  });

  it("does not let a current exact rule bypass the complete token cap", () => {
    manager.setRules([withCurrentShellRuleVersion({ pattern: "Bash(:)", action: "allow" })]);
    const command = ":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1);
    expect(command.length).toBeLessThanOrEqual(2_000);
    for (const runsSandboxed of [false, true]) {
      expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", runsSandboxed)).toMatchObject(runsSandboxed
        ? { decision: "ask", layer: 2, forceModal: true } : { decision: "ask", layer: 6 });
      expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", runsSandboxed, true).decision).not.toBe("allow");
    }
  });

  it.each([
    { name: "comments", command: "#\n".repeat(4_000), allowed: false },
    { name: "empty-arithmetic", command: "(())\n".repeat(1_600), allowed: false },
  ])("bounds low-record representation $name", ({ name, command, allowed }) => {
    expect(command.length).toBe(8_000);
    const samples: number[] = [];
    const results = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const start = performance.now();
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true);
      samples.push(performance.now() - start);
      results.push(result);
    }
    const median = [...samples].sort((left, right) => left - right)[1]!;
    process.stdout.write(`decision shape cost ${JSON.stringify({ name, chars: command.length, samples, median, results })}\n`);
    for (const result of results) expect(result).toMatchObject(allowed
      ? { decision: "allow", layer: 3 }
      : { decision: "ask", layer: 2, forceModal: true });
    expect(median).toBeLessThan(permissionDecisionCostTargetMs);
  });
});
