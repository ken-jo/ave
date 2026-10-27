import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../../permissions/approval-gate.js";

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

async function authorizedContext(cwd: string, command = "touch marker", rulePatterns: readonly string[] = ["Bash(touch marker)"]) {
  const plan = getHostShellExecutionPlan("host");
  const input = { command, cwd, executionMode: "host" as const, justification: "Run in the approved directory", timeoutSeconds: 10 };
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setRules(rulePatterns.map((pattern) => ({ pattern, action: "allow" as const, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION })));
  const decision = manager.checkDetailed("bash", "builtin", "shell", null, {
    hostShellExecutionPlan: plan, ruleSubject: { kind: "shell", dialect: "bash", command: input.command, cwd: join(directory, cwd) },
    // An explicit host retry runs without a sandbox, so only an exact Bash(<command>) allow issues the rule proof (owner 2026-10-25, unsandboxed shell exact-rule requirement).
    shellExecution: { runsSandboxed: false },
  });
  const binding = buildHostShellExecutionPermitBinding({
    plan, toolName: "bash", toolUseId: "cwd-spawn", rawInput: input, executionCwd: directory, extraAllowedDirectories: [],
  })!;
  let approvalDecision: ApprovalDecision | undefined;
  if (decision.decision !== "allow") {
    const webContents = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const gate = new ApprovalGate(webContents as never);
    const pending = gate.requestAndWait({
      id: "cwd-spawn-approval", category: "tool", toolName: "bash", toolCategory: "shell", args: input,
      reason: "Approve the one host command used by the cwd race fixture", source: "builtin", createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"], forceExplicit: true, hostShellExecutionPermitBinding: binding,
    });
    const request = webContents.send.mock.calls[0]?.[1] as ApprovalRequest | undefined;
    if (!request?.nonce || !request.hmac) throw new Error("ApprovalGate did not publish a sealed request");
    gate.resolveFromDesktopRenderer("cwd-spawn-approval", { requestId: "cwd-spawn-approval", choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, webContents as never);
    approvalDecision = await pending;
  }
  const permit = mintHostShellExecutionPermit({
    plan, binding, approvalDecision,
    ...(approvalDecision === undefined ? { allowRuleDecision: decision, permissionManager: manager } : {}),
  });
  expect(permit).toBeDefined();
  return { input, context: { cwd: directory, extraAllowedDirectories: [], metadata: { toolUseId: "cwd-spawn" }, hostShellExecutionPlan: plan, hostShellExecutionPermit: permit } };
}

// A bare tool rule does not admit a shell; exact Bash(...) rules cover each command.
const COMPOUND_RULES = ["Bash(printf command-ran)", "Bash(printf C)", "Bash(exit 0)", "Bash(exit 197)"];

describe("host cwd races after permit consumption", () => {
  it("preserves an ordinary exit 197 and the command's output", async () => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current", "printf command-ran; exit 197", COMPOUND_RULES);
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(true);
    expect(result.metadata?.returncode).toBe(197);
    expect(result.output).toContain("command-ran");
    expect(result.output).not.toMatch(/permission policy changed|authorization again/i);
  });

  it("closes the guard channel before the command can write to it", async () => {
    mkdirSync(join(directory, "current"));
    const command = "bash -c 'printf command-ran; if { printf C >&3; } 2>/dev/null; then exit 0; else exit 197; fi'";
    const { input, context } = await authorizedContext("current", command, [`Bash(${command})`]);
    const result = await new BashTool().execute(input, context);
    expect(result.output).toContain("command-ran");
    expect(result.metadata?.returncode).toBe(197);
    expect(result.output).not.toMatch(/permission policy changed|authorization again/i);
  });

  it.each(["project", "user"] as const)("honours a %s deny submitted by this host at native spawn", async (scope) => {
    const current = join(directory, "current");
    mkdirSync(current);
    const { input, context } = await authorizedContext("current");
    const writer = new PermissionManager(join(directory, "permissions.json"));
    let persisted: Promise<void> | undefined;
    spawnBoundary.mutate = () => {
      persisted = writer.addRulePersist({ pattern: "Bash(touch *)", action: "deny" }, scope === "project"
        ? { kind: "project", projectCwd: current } : { kind: "user" });
    };
    const result = await new BashTool().execute(input, context);
    await persisted;
    expect(persisted).toBeDefined();
    if (process.platform === "win32") {
      // The synchronous native handoff precedes this queued write on platforms without a child guard, so the mutation applies to the next invocation.
      expect(result.isError).toBe(false);
      expect(existsSync(join(current, "marker"))).toBe(true);
      return;
    }
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/permission policy changed/i);
    expect(existsSync(join(current, "marker"))).toBe(false);
  });

  it("validates an external policy write at native spawn before granting the waiting child", async () => {
    const current = join(directory, "current");
    mkdirSync(current);
    const { input, context } = await authorizedContext("current");
    spawnBoundary.mutate = () => {
      writeFileSync(join(directory, "permissions.json"), JSON.stringify({
        version: 1, rules: [{ pattern: "Bash(touch *)", action: "deny" }], mode: "default", updatedAt: new Date().toISOString(),
      }));
    };
    const result = await new BashTool().execute(input, context);
    if (process.platform === "win32") {
      // Uncoordinated edits after native handoff validation reach the next call.
      expect(result.isError).toBe(false);
      expect(existsSync(join(current, "marker"))).toBe(true);
      return;
    }
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/permission policy changed/i);
    expect(existsSync(join(current, "marker"))).toBe(false);
  });

  it("preserves literal quoted directory names and supported newlines", async () => {
    const name = process.platform === "win32" ? "quoted' directory" : "quoted' directory\n";
    mkdirSync(join(directory, name));
    const { input, context } = await authorizedContext(name);
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
    const { input, context } = await authorizedContext("current");
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
    const { input, context } = await authorizedContext("current");
    spawnBoundary.mutate = () => {
      renameSync(current, original);
      mkdirSync(current);
    };
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.cwd).toBe(current);
    if (process.platform === "win32") {
      // Physical spawn protects junction retargeting, but native child-side directory identity verification is not implemented on this platform.
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
