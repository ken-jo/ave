import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { countDecisionWork, decisionWorkSummary as json, expectLinearDecisionWork, expectRefusedAtAnalysisCap } from "../../__tests__/support/permission-decision-cost.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
let cwd: string;
let stateRoot: string;
let manager: PermissionManager;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "permission-work-")));
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "permission-work-state-")));
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

function distinctRelativePaths(length: number, radix: number, nested = false): string {
  let command = "echo hi > out.txt; cd a0; cd a1; cd a2; cd a3; printf %s";
  for (let index = 0; command.length < length; index += 1) {
    if (nested && index > 0 && index % 40 === 0) command += " $(:)";
    command += ` ./p${index.toString(radix)}`;
  }
  return command.slice(0, length);
}

const WORK_CASES = [
  ...(["bash", "powershell"] as const).flatMap((dialect) =>
    [false, true].flatMap((runsSandboxed) => [10, 36].map((radix) => ({ dialect, runsSandboxed, radix, nested: false, length: runsSandboxed ? 7_999 : 1_999 }))),
  ),
  ...[false, true].map((runsSandboxed) => ({ dialect: "bash" as const, runsSandboxed, radix: 36, nested: true, length: runsSandboxed ? 7_999 : 1_999 })),
];

describe("adversarial complete manager work", () => {
  it("visits nested PowerShell script blocks without repeated subtree analysis", () => {
    const depth = 14;
    const command = "& { ".repeat(depth) + "Write-Output ready" + " }".repeat(depth);
    const results = [];
    const counted = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const { result, work } = countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, command, "powershell", true));
      results.push(result);
      counted.push(work);
    }
    const work = counted[0]!;
    process.stdout.write(`permission nested work ${JSON.stringify({ depth, chars: command.length, work: json(work), results: results.map(({ decision, forceModal }) => ({ decision, forceModal: forceModal === true })) })}\n`);
    for (const result of results) expect(result).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    // Repeating the decision repeats exactly the same work: nothing accumulates across decisions.
    for (const repeated of counted) expect(json(repeated)).toEqual(json(work));
    // The command is parsed once, and each of its script blocks is analyzed once rather than once per enclosing block.
    expect(work.get("parsePowerShellCommand")).toEqual({ calls: 1, chars: command.length });
    for (const name of ["inspectPosixShellPermissionPaths", "parseShellSyntax"]) expect(work.get(name)?.calls, name).toBeLessThanOrEqual(depth + 1);
    for (const result of results) expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, "powershell", true);
    expect(permitted).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(permitted.pipelineRequest?.shell).toEqual(results[0]!.pipelineRequest?.shell);
  });

  it.each(WORK_CASES)("$dialect sandboxed=$runsSandboxed radix=$radix nested=$nested", ({ dialect, runsSandboxed, radix, nested, length }) => {
    const command = distinctRelativePaths(length, radix, nested);
    expect(command.length).toBe(length);
    const distinctPathRecords = command.match(/\.\/p[0-9a-z]+/gu)?.length ?? 0;
    if (runsSandboxed) expect(distinctPathRecords).toBeGreaterThan(MAX_SHELL_ANALYSIS_TOKENS);
    else expect(distinctPathRecords).toBeLessThan(MAX_SHELL_ANALYSIS_TOKENS);
    // The same shape at a quarter of the length, in the same lane, for the growth comparison of a fully analyzed decision.
    const smallCommand = distinctRelativePaths(Math.floor(length / 4), radix, nested);
    const small = runsSandboxed ? undefined : countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, smallCommand, dialect, runsSandboxed));
    const results = [];
    const counted = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const { result, work } = countDecisionWork(() => checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed));
      results.push(result);
      counted.push(work);
    }
    const work = counted[0]!;
    process.stdout.write(`permission adversarial work ${JSON.stringify({ dialect, radix, nested, lane: runsSandboxed ? "A" : "B", chars: length, smallChars: small ? smallCommand.length : undefined, work: json(work), smallWork: small ? json(small.work) : undefined, results: results.map(({ decision, forceModal }) => ({ decision, forceModal: forceModal === true })) })}\n`);
    // In the contained lane these inputs exceed the complete evidence token budget, which leaves the answer to the mode.
    const expected = { decision: "ask", reasonCode: "shell-approval" };
    for (const result of results) expect(result).toMatchObject(expected);
    for (const repeated of counted) expect(json(repeated)).toEqual(json(work));
    if (small) {
      expect(small.result).toMatchObject(expected);
      expectLinearDecisionWork(small.work, work, command.length / smallCommand.length);
    } else {
      expectRefusedAtAnalysisCap(work, command);
    }
    for (const result of results) expect(result.forceModal).toBeUndefined();
    manager.setMode("allow");
    const permitted = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
    expect(permitted).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(permitted.pipelineRequest?.shell).toEqual(results[0]!.pipelineRequest?.shell);
  });
});
