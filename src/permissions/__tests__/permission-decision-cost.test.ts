import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { analysisLimitAnswer, checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { countDecisionWork, decisionWorkSummary, expectLinearDecisionWork, expectRefusedAtAnalysisCap } from "../../__tests__/support/permission-decision-cost.js";
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
  manager.setMode("default");
});

afterEach(() => {
  vi.restoreAllMocks();
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

interface DecisionWorkCase {
  name: string;
  command: string;
  dialect: "bash" | "powershell";
  runsSandboxed: boolean;
  /** `limit`: the evidence budget is spent, so the mode answers this contained command without the analysis. */
  expected: "ask" | "limit";
  words?: number;
  executableChars: number;
  dataBytes?: number;
  /** The same shape at a smaller scale in the same lane and decision, for the growth comparison of an admitted (fully analyzed) decision. */
  small?: string;
}

const CASES: readonly DecisionWorkCase[] = [
  { name: "plain", command: PLAIN_COMMAND, dialect: "bash", runsSandboxed: true, expected: "limit", executableChars: 7_900 },
  { name: "quoted-data", command: LARGE_COMMAND, dialect: "bash", runsSandboxed: true, expected: "limit", executableChars: 7_916, dataBytes: 60_000 },
  ...(["bash", "powershell"] as const).flatMap((dialect) => [false, true].map((runsSandboxed) => ({
    name: `max-${dialect}-${runsSandboxed ? "sandboxed" : "unsandboxed"}`,
    command: commandWithDistinctPaths(runsSandboxed ? 8_000 : 2_000), dialect, runsSandboxed, expected: runsSandboxed ? "limit" as const : "ask" as const,
    executableChars: runsSandboxed ? 8_000 : 2_000,
    // 480 characters end on a complete path word, as 2,000 do; a cut stage name would add a native stage to one size only.
    ...(runsSandboxed ? {} : { small: commandWithDistinctPaths(480) }),
  }))),
  { name: "max-quoted-data", command: quotedData(commandWithDistinctPaths(7_984), 65_536), dialect: "bash", runsSandboxed: true, expected: "limit", executableChars: 8_000, dataBytes: 65_536 },
  { name: "admitted-token-cap", command: commandWithWords(MAX_SHELL_ANALYSIS_TOKENS, 8_000), dialect: "bash", runsSandboxed: true, expected: "ask", executableChars: 8_000, words: MAX_SHELL_ANALYSIS_TOKENS,
    small: commandWithWords(MAX_SHELL_ANALYSIS_TOKENS / 2, 4_000) },
  { name: "admitted-token-cap-data", command: quotedData(commandWithWords(MAX_SHELL_ANALYSIS_TOKENS - 2, 7_984), 65_536), dialect: "bash", runsSandboxed: true, expected: "ask", executableChars: 8_000, dataBytes: 65_536, words: MAX_SHELL_ANALYSIS_TOKENS,
    small: quotedData(commandWithWords(MAX_SHELL_ANALYSIS_TOKENS / 2 - 2, 3_984), 32_768) },
  { name: "admitted-pipeline", command: pipelineCommand(100, 8_000), dialect: "bash", runsSandboxed: true, expected: "ask", executableChars: 8_000, words: 400,
    small: pipelineCommand(50, 4_000) },
];

describe("bounded complete decision cost", () => {
  it.each(CASES)("$name", ({ name, command, dialect, runsSandboxed, expected, words, executableChars, dataBytes, small }) => {
    expect(command.length).toBe(executableChars + (dataBytes ?? 0));
    const outcome = { decision: "ask", reasonCode: "shell-approval" };
    // A refusal at the cap is checked on its own; an admitted decision is compared with the same shape at a smaller scale.
    expect(small === undefined).toBe(expected === "limit");
    const smaller = small === undefined ? undefined : countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, small, dialect, runsSandboxed));
    const results = [];
    const counted = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const { result, work } = countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed));
      results.push(result);
      counted.push(work);
    }
    const work = counted[0]!;
    process.stdout.write(`decision cost ${JSON.stringify({ name, dialect, lane: runsSandboxed ? "A" : "B", chars: command.length, smallChars: small?.length, executableChars, dataBytes, words, work: decisionWorkSummary(work), smallWork: smaller ? decisionWorkSummary(smaller.work) : undefined, results: results.map(({ decision, forceModal }) => ({ decision, forceModal: forceModal === true })) })}\n`);
    for (const result of results) expect(result).toMatchObject(outcome);
    // Repeating the decision repeats exactly the same work: nothing accumulates across decisions.
    for (const repeated of counted) expect(decisionWorkSummary(repeated)).toEqual(decisionWorkSummary(work));
    if (smaller && small !== undefined) {
      expect(smaller.result).toMatchObject(outcome);
      expectLinearDecisionWork(smaller.work, work, command.length / small.length);
    } else {
      expectRefusedAtAnalysisCap(work, command);
    }
    for (const result of results) expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
    expect(permitted).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(permitted.pipelineRequest?.shell).toEqual(results[0]!.pipelineRequest?.shell);
  }, 60_000);

  it.each([false, true])("counts records across command boundaries nested=%s", (nested) => {
    const prefix = nested ? "echo $(:); " : "";
    const prefixWords = nested ? 3 : 0;
    const command = `${prefix}${":;".repeat(MAX_SHELL_ANALYSIS_TOKENS - prefixWords)}`;
    expect(parseShellFloorCommand(command).analysis.ok).toBe(true);
    expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true)).toMatchObject(nested
      ? { decision: "ask", reasonCode: "shell-approval" } : { decision: "allow" });
    expect(checkShellPermission(manager, cwd, SESSION_ID, `${command}:`, "bash", true)).toMatchObject({ decision: "ask", reasonCode: "shell-approval", pipelineRequest: { shell: { unproven: true } } });
    expect(checkShellPermission(manager, cwd, SESSION_ID, `${command}:`, "bash", false)).toMatchObject(analysisLimitAnswer(false, false, {}));
  });

  it("counts assignment values across the complete command", () => {
    const command = "A=1;".repeat(MAX_SHELL_ANALYSIS_TOKENS);
    expect(parseShellFloorCommand(command).analysis.ok).toBe(true);
    expect(parseShellFloorCommand(`${command}A=1`).analysis.ok).toBe(false);
    expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true)).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    expect(checkShellPermission(manager, cwd, SESSION_ID, `${command}A=1`, "bash", true)).toMatchObject({ decision: "ask", reasonCode: "shell-approval", pipelineRequest: { shell: { unproven: true } } });
    expect(checkShellPermission(manager, cwd, SESSION_ID, `${command}A=1`, "bash", false)).toMatchObject(analysisLimitAnswer(false, false, {}));
  });

  it("does not let a current exact rule bypass the complete token cap", () => {
    manager.setRules([withCurrentShellRuleVersion({ pattern: "Bash(:)", action: "allow" })]);
    const command = ":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1);
    expect(command.length).toBeLessThanOrEqual(2_000);
    for (const runsSandboxed of [false, true]) {
      const bounded = checkShellPermission(manager, cwd, SESSION_ID, command, "bash", runsSandboxed);
      expect(bounded).toMatchObject({ ...analysisLimitAnswer(runsSandboxed, false, { decision: "ask", reasonCode: "shell-approval" }), pipelineRequest: { shell: { unproven: true, readOnlyProven: false } } });
      expect(bounded.pipelineRequest?.rules?.allow).toBeUndefined();
      expect(checkShellPermission(manager, cwd, SESSION_ID, command, "bash", runsSandboxed, true).decision).not.toBe("allow");
    }
    expect(parseShellFloorCommand(command).analysis.ok).toBe(false);
    manager.setMode("allow");
    for (const runsSandboxed of [false, true]) {
      const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, "bash", runsSandboxed, true);
      expect(permitted).toMatchObject({ ...analysisLimitAnswer(runsSandboxed, true, { decision: "allow", reasonCode: "allow-mode" }), pipelineRequest: { shell: { unproven: true, readOnlyProven: false } } });
      expect(permitted.pipelineRequest?.rules?.allow).toBeUndefined();
    }
  });

  it.each([
    { name: "comments", command: "#\n".repeat(4_000), expected: "limit" },
    // No word records: the shape is parsed and inspected once, so its growth is in input characters alone.
    { name: "empty-arithmetic", command: "(())\n".repeat(1_600), expected: "ask", small: "(())\n".repeat(800) },
  ])("bounds low-record representation $name", ({ name, command, expected, small }) => {
    expect(small === undefined).toBe(expected === "limit");
    expect(command.length).toBe(8_000);
    const outcome = { decision: "ask", reasonCode: "shell-approval" };
    const results = [];
    const counted = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const { result, work } = countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true));
      results.push(result);
      counted.push(work);
    }
    const work = counted[0]!;
    const smaller = small === undefined ? undefined : countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, small, "bash", true));
    process.stdout.write(`decision shape cost ${JSON.stringify({ name, chars: command.length, work: decisionWorkSummary(work), smallWork: smaller ? decisionWorkSummary(smaller.work) : undefined, results })}\n`);
    for (const result of results) expect(result).toMatchObject(outcome);
    for (const repeated of counted) expect(decisionWorkSummary(repeated)).toEqual(decisionWorkSummary(work));
    if (smaller && small !== undefined) {
      expect(smaller.result).toMatchObject(outcome);
      expectLinearDecisionWork(smaller.work, work, command.length / small.length, 0);
    } else {
      expectRefusedAtAnalysisCap(work, command);
    }
    for (const result of results) expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, "bash", true);
    expect(permitted).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(permitted.pipelineRequest?.shell).toEqual(results[0]!.pipelineRequest?.shell);
  });
});
