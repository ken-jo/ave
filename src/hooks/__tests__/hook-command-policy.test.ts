import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createHookCommandAuthorizer } from "../hook-command-policy.js";
import { runOneHookScript, type RunnableHook } from "../script-hook-runner.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import type { ScriptHookStdin } from "../script-hook-types.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { resolveTurnExtensionPolicy, turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";

vi.mock("../../permissions/asrt-sandbox.js", async (original) => ({
  ...await original<typeof import("../../permissions/asrt-sandbox.js")>(),
  isAsrtSandboxActive: () => false,
}));

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
const hook = { id: "config:PreToolUse#0.0", hookType: "pre" as const, hookPath: COMMAND, command: ["node", COMMAND, "echo"] };
const payload: ScriptHookStdin = { hookType: "pre", toolName: "read_file", source: "builtin", category: "read",
  input: {}, sessionId: "hook-policy-session", trustOrigin: "user-keyboard" };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  __resetSandboxRequestedAtBootForTest();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function policy(choice: "allow-once" | "deny-once" = "deny-once") {
  const root = mkdtempSync(join(tmpdir(), "ave-hook-policy-"));
  roots.push(root);
  const permissionManager = new PermissionManager(join(root, "permissions.json"));
  const requestAndWait = vi.fn(async () => ({ requestId: "hook", choice }));
  return { permissionManager, requestAndWait,
    authorizeCommand: createHookCommandAuthorizer({ permissionManager, approvalGate: { requestAndWait } }) };
}

describe("hook command permission admission", () => {
  it("keeps a real shell deny rule above enrollment and user approval", async () => {
    const p = policy("allow-once");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "deny" }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision).toBe("deny");
    expect(result.rawStdout).toBe("");
    expect(result.reason).toContain("hook command denied");
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it("requires an exact affirmative approval when shell policy asks", async () => {
    const p = policy("allow-once");
    p.permissionManager.setMode("strict");
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(p.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "bash", toolCategory: "shell", sessionId: "hook-policy-session",
      forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false,
      args: expect.objectContaining({ cwd: process.cwd(), hook: hook.id }),
    }));
  });

  it("never spawns a denied command even when the hook would return allow", async () => {
    const p = policy();
    p.permissionManager.setMode("strict");
    expect(await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook command denied: user denied hook command" });
  });

  it("respects a deny rule added while approval was pending", async () => {
    const p = policy("allow-once");
    p.permissionManager.setMode("strict");
    p.requestAndWait.mockImplementationOnce(async () => {
      p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "deny" }]);
      return { requestId: "hook", choice: "allow-once" };
    });
    expect(await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: expect.stringContaining("hook command denied") });
  });

  it("invalidates an automatic admission when an ask rule replaces its allow", async () => {
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const admitted = await p.authorizeCommand({ ...hook, command: ["node", "--version"] }, payload, process.cwd());
    expect(admitted.decision).toBe("allow");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "ask" }]);
    expect(admitted.assertAllowed).toBeTypeOf("function");
    expect(() => admitted.assertAllowed!()).toThrow("Hook command permission changed");
  });

  it("requires approval for interpreter code even with a matching shell allow rule", async () => {
    const p = policy("allow-once");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(p.requestAndWait).toHaveBeenCalledOnce();
  });

  it("fails closed when admission throws and does not serialize a forged event", async () => {
    const authorizeCommand = vi.fn(async () => { throw new Error("policy unavailable"); });
    expect(await runOneHookScript(hook, payload, { authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook command admission failed: policy unavailable" });
    authorizeCommand.mockClear();
    expect(await runOneHookScript({ ...hook, hookType: "Stop" }, payload, { authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook event does not match its input" });
    expect(authorizeCommand).not.toHaveBeenCalled();
  });

  it("keeps the host admission callback when a caller supplies execution options", async () => {
    const manager = new ScriptHookManager();
    const admission = vi.fn(async () => ({ decision: "deny" as const, reason: "host rule" }));
    manager.setCommandAuthorizer(admission);
    manager.setTrustedRegistry([], [{ id: hook.id, event: "pre", source: "config", command: hook.command, timeoutMs: 5000 }]);
    const result = await manager.runPreToolUse(payload, { authorizeCommand: async () => ({ decision: "allow", reason: "caller" }) });
    expect(result.decision).toBe("deny");
    expect(admission).toHaveBeenCalledOnce();
  });

  it("executes the command snapshot admitted before the original argv changes", async () => {
    const mutableHook = { ...hook, command: [...hook.command] };
    const authorizeCommand = vi.fn(async (admitted: RunnableHook) => {
      expect(Object.isFrozen(admitted.command)).toBe(true);
      mutableHook.command[2] = "block";
      return { decision: "allow" as const, reason: "approved snapshot" };
    });
    const result = await runOneHookScript(mutableHook, payload, { authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(JSON.parse(result.rawStdout).reason).toBe("received");
  });

  it("requires a genuine one-shot receipt when the requested sandbox is unavailable", async () => {
    setSandboxRequestedAtBoot(true);
    const p = policy("allow-once");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result).toMatchObject({ decision: "deny", rawStdout: "", reason: expect.stringContaining("approval receipt is invalid") });
    expect(p.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ hostShellExecutionPermitBinding: expect.any(Object) }));
  });

  it("consumes a real gate-approved host execution receipt before spawning", async () => {
    setSandboxRequestedAtBoot(true);
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const gate = new ApprovalGate(wc as never);
    const authorizeCommand = createHookCommandAuthorizer({ permissionManager: p.permissionManager, approvalGate: gate });
    const pending = runOneHookScript(hook, payload, { authorizeCommand });
    const deadline = Date.now() + 3000;
    while (wc.send.mock.calls.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 1));
    const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
    expect(request?.nonce).toBeTruthy();
    gate.resolve(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });
    const result = await pending;
    expect(result.decision, result.reason).toBe("allow");
    expect(JSON.parse(result.rawStdout).reason).toBe("received");
  });

  it("refuses to spawn after the admitted sandbox generation changes", async () => {
    const authorizeCommand = async () => {
      const plan = getHostShellExecutionPlan();
      setSandboxRequestedAtBoot(true);
      return { decision: "allow" as const, reason: "approved", plan };
    };
    expect(await runOneHookScript(hook, payload, { authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook shell execution policy changed during approval" });
  });

  it("preserves unattended shell approval requirements instead of reusing a foreground allow rule", async () => {
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result.decision).toBe("deny");
    expect(p.requestAndWait).toHaveBeenCalledOnce();
  });
});
