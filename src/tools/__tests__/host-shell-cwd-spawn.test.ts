import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const spawnBoundary = vi.hoisted(() => ({
  mutate: undefined as (() => void) | undefined,
  cwd: undefined as string | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      if (spawnBoundary.mutate !== undefined) {
        const mutate = spawnBoundary.mutate;
        spawnBoundary.mutate = undefined;
        spawnBoundary.cwd = String(args[2]?.cwd);
        mutate();
      }
      return actual.spawn(...args);
    }),
  };
});

import { PermissionManager } from "../../permissions/permission-manager.js";
import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit } from "../../permissions/host-shell-execution-permit.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan } from "../../permissions/sandbox-capability.js";
import { BashTool } from "../shell-tools.js";
import { HOST_SHELL_CWD_REVOKED_EXIT_CODE } from "../host-shell-cwd-guard.js";

let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-cwd-spawn-")));
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  spawnBoundary.mutate = undefined;
  spawnBoundary.cwd = undefined;
});
afterEach(() => {
  spawnBoundary.mutate = undefined;
  cleanupTmpDir(directory);
});

function authorizedContext(cwd: string) {
  const plan = getHostShellExecutionPlan("host");
  const input = { command: "touch marker", cwd, executionMode: "host" as const, justification: "Run in the approved directory", timeoutSeconds: 10 };
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setRules([{ pattern: "Bash(touch *)", action: "allow" }]);
  const decision = manager.checkDetailed("bash", "builtin", "shell", null, {
    hostShellExecutionPlan: plan, ruleSubject: { kind: "shell", dialect: "bash", command: input.command, cwd: join(directory, cwd) },
  });
  const binding = buildHostShellExecutionPermitBinding({
    plan, toolName: "bash", toolUseId: "cwd-spawn", rawInput: input, executionCwd: directory, extraAllowedDirectories: [],
  })!;
  const permit = mintHostShellExecutionPermit({ plan, binding, approvalDecision: undefined, allowRuleDecision: decision, permissionManager: manager });
  expect(permit).toBeDefined();
  return { input, context: { cwd: directory, extraAllowedDirectories: [], metadata: { toolUseId: "cwd-spawn" }, hostShellExecutionPlan: plan, hostShellExecutionPermit: permit } };
}

describe("host cwd races after permit consumption", () => {
  it("preserves literal quoted directory names and supported newlines", async () => {
    const name = process.platform === "win32" ? "quoted' directory" : "quoted' directory\n";
    mkdirSync(join(directory, name));
    const { input, context } = authorizedContext(name);
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(false);
    expect(existsSync(join(directory, name, "marker"))).toBe(true);
  });

  it("spawns in the verified physical directory when a symlink is retargeted at native spawn", async () => {
    const first = join(directory, "first");
    const second = join(directory, "second");
    mkdirSync(first);
    mkdirSync(second);
    const current = join(directory, "current");
    symlinkSync(first, current, "junction");
    const { input, context } = authorizedContext("current");
    spawnBoundary.mutate = () => {
      unlinkSync(current);
      symlinkSync(second, current, "junction");
    };
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.cwd).toBe(first);
    expect(result.isError).toBe(false);
    expect(existsSync(join(first, "marker"))).toBe(true);
    expect(existsSync(join(second, "marker"))).toBe(false);
  });

  it("applies the child identity check when a directory is replaced after the host permit check", async () => {
    const current = join(directory, "current");
    const original = join(directory, "original");
    mkdirSync(current);
    const { input, context } = authorizedContext("current");
    spawnBoundary.mutate = () => {
      renameSync(current, original);
      mkdirSync(current);
    };
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.cwd).toBe(current);
    if (process.platform === "win32") {
      // Physical spawn protects junction retargeting, but native child-side
      // directory identity verification is not implemented on this platform.
      expect(result.isError).toBe(false);
      expect(existsSync(join(current, "marker"))).toBe(true);
      return;
    }
    expect(result.isError).toBe(true);
    expect(result.metadata?.returncode).toBe(HOST_SHELL_CWD_REVOKED_EXIT_CODE);
    expect(result.output).toMatch(/working directory.*changed/i);
    expect(existsSync(join(current, "marker"))).toBe(false);
    expect(existsSync(join(original, "marker"))).toBe(false);
  });
});
