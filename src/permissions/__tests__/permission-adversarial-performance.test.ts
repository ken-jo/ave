import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { permissionDecisionCostTargetMs } from "../../__tests__/support/permission-decision-cost.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";


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
  manager.setMode("allow");
});

afterEach(() => {
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

const TIMING_CASES = [
  ...(["bash", "powershell"] as const).flatMap((dialect) =>
    [false, true].flatMap((runsSandboxed) => [10, 36].map((radix) => ({ dialect, runsSandboxed, radix, nested: false, length: runsSandboxed ? 7_999 : 1_999 }))),
  ),
  ...[false, true].map((runsSandboxed) => ({ dialect: "bash" as const, runsSandboxed, radix: 36, nested: true, length: runsSandboxed ? 7_999 : 1_999 })),
];

describe("adversarial complete manager timing", () => {
  it("visits nested PowerShell script blocks without repeated subtree analysis", () => {
    const depth = 14;
    const command = "& { ".repeat(depth) + "Write-Output ready" + " }".repeat(depth);
    const samples: number[] = [];
    const results = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const start = performance.now();
      results.push(checkShellPermission(manager, cwd, SESSION_ID, command, "powershell", true));
      samples.push(performance.now() - start);
    }
    const median = [...samples].sort((left, right) => left - right)[1]!;
    process.stdout.write(`permission nested timing ${JSON.stringify({ depth, chars: command.length, samples, median, results: results.map(({ decision, layer, forceModal }) => ({ decision, layer, forceModal: forceModal === true })) })}\n`);
    for (const result of results) expect(result).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(median).toBeLessThan(permissionDecisionCostTargetMs);
  });

  it.each(TIMING_CASES)("$dialect sandboxed=$runsSandboxed radix=$radix nested=$nested", ({ dialect, runsSandboxed, radix, nested, length }) => {
    const command = distinctRelativePaths(length, radix, nested);
    expect(command.length).toBe(length);
    const samples: number[] = [];
    const results = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const start = performance.now();
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
      samples.push(performance.now() - start);
      results.push(result);
    }
    const median = [...samples].sort((left, right) => left - right)[1]!;
    process.stdout.write(`permission adversarial timing ${JSON.stringify({ dialect, radix, nested, lane: runsSandboxed ? "A" : "B", chars: length, samples, median, results: results.map(({ decision, layer, forceModal }) => ({ decision, layer, forceModal: forceModal === true })) })}\n`);
    for (const result of results) expect(result).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(median).toBeLessThan(permissionDecisionCostTargetMs);
  });
});
