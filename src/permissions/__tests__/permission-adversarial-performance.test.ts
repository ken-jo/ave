import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
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

function distinctRelativePaths(length: number): string {
  let command = "echo hi > out.txt; cd a0; cd a1; cd a2; cd a3; printf %s";
  for (let index = 0; command.length < length; index += 1) command += ` ./p${index}`;
  return command.slice(0, length);
}

const TIMING_CASES = (["bash", "powershell"] as const).flatMap((dialect) =>
  [false, true].flatMap((runsSandboxed) => [1, 2, 3].map((observation) => ({
    dialect,
    runsSandboxed,
    observation,
    length: runsSandboxed ? 7_999 : 1_999,
  }))),
);

describe("adversarial complete manager timing", () => {
  it.each(TIMING_CASES)("$dialect sandboxed=$runsSandboxed observation=$observation", ({ dialect, runsSandboxed, observation, length }) => {
    const command = distinctRelativePaths(length);
    expect(command.length).toBe(length);
    const start = performance.now();
    const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
    const elapsed = performance.now() - start;
    process.stdout.write(`permission adversarial timing ${dialect} sandboxed=${runsSandboxed} chars=${length} observation=${observation} decision=${result.decision} layer=${result.layer} modal=${result.forceModal === true} ms=${elapsed.toFixed(3)}\n`);
    expect(result.decision).toBe("ask");
    expect(elapsed).toBeLessThan(50);
  });
});
