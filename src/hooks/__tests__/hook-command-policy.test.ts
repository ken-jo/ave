vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

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
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan,
  setActiveSandboxCapability, setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { resolveTurnExtensionPolicy, turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";

const sandboxedHost = vi.hoisted(() => ({ active: false }));
vi.mock("../../permissions/asrt-sandbox.js", async (original) => ({
  ...await original<typeof import("../../permissions/asrt-sandbox.js")>(),
  isAsrtSandboxActive: () => false,
}));

// The partial Windows sandbox plan requires a per-invocation permit; an unavailable sandbox does not. Override only the plan's platform probe so the hook still runs on this host.
const plans = vi.hoisted(() => ({ windowsPartial: false }));
vi.mock("../../permissions/sandbox-capability.js", async (original) => {
  const actual = await original<typeof import("../../permissions/sandbox-capability.js")>();
  return {
    ...actual,
    getHostShellExecutionPlan: (mode?: Parameters<typeof actual.getHostShellExecutionPlan>[0]) => {
      if (sandboxedHost.active) {
        return { ...actual.getHostShellExecutionPlan(mode), mode: "asrt", sandboxed: true, requiresExplicitUserApproval: false };
      }
      if (!plans.windowsPartial) return actual.getHostShellExecutionPlan(mode);
      const platform = process.platform;
      setProcessPlatform("win32");
      try {
        return actual.getHostShellExecutionPlan(mode);
      } finally {
        setProcessPlatform(platform);
      }
    },
  };
});
const permits = vi.hoisted(() => ({ minted: 0, consumed: [] as boolean[] }));
vi.mock("../../permissions/host-shell-execution-permit.js", async (original) => {
  const actual = await original<typeof import("../../permissions/host-shell-execution-permit.js")>();
  return {
    ...actual,
    mintHostShellExecutionPermit: (input: Parameters<typeof actual.mintHostShellExecutionPermit>[0]) => {
      permits.minted += 1;
      return actual.mintHostShellExecutionPermit(input);
    },
    consumeHostShellExecutionPermit: (input: Parameters<typeof actual.consumeHostShellExecutionPermit>[0]) => {
      const consumed = actual.consumeHostShellExecutionPermit(input);
      permits.consumed.push(consumed);
      return consumed;
    },
  };
});

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
const hook = { id: "config:PreToolUse#0.0", hookType: "pre" as const, hookPath: COMMAND, command: ["node", COMMAND, "echo"] };
const payload: ScriptHookStdin = { hookType: "pre", toolName: "read_file", source: "builtin", category: "read",
  input: {}, sessionId: "hook-policy-session", trustOrigin: "user-keyboard" };
const roots: string[] = [];
afterEach(async () => {
  sandboxedHost.active = false;
  plans.windowsPartial = false;
  __resetActiveSandboxCapabilityForTest();
  permits.minted = 0;
  permits.consumed.length = 0;
  vi.restoreAllMocks();
  __resetSandboxRequestedAtBootForTest();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

// The Windows partial-ASRT plan: requested sandbox, srt-win active, process confinement absent.
function windowsPartialPlan(): void {
  plans.windowsPartial = true;
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({
    kind: "asrt", confidence: "verified", platform: "win32", reason: "srt-win partial",
    confines: { filesystem: true, process: false, network: true },
  });
}

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

  // Owner 2026-10-25 (unsandboxed shell exact-rule requirement): a hook runs without a sandbox, so only an exact Bash(<command>) rule admits it, on any host.
  it.each([true, false])("admits a hook only through an exact allow (sandbox-capable host %s)", async (active) => {
    sandboxedHost.active = active;
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
    const command = { ...hook, command: ["printf", "ready"] };
    expect((await p.authorizeCommand(command, payload, process.cwd())).decision).toBe("deny");
    expect(p.requestAndWait).toHaveBeenCalledOnce();
    p.permissionManager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    const admitted = await p.authorizeCommand(command, payload, process.cwd());
    expect(admitted.decision, admitted.reason).toBe("allow");
    expect(p.requestAndWait).toHaveBeenCalledOnce();
  });

  it("invalidates an automatic admission when an ask rule replaces its allow", async () => {
    const p = policy();
    // Exact: a hook runs without a sandbox, so a wildcard allow never admits it.
    p.permissionManager.setRules([{ pattern: "Bash(node --version)", action: "allow" }]);
    const admitted = await p.authorizeCommand({ ...hook, command: ["node", "--version"] }, payload, process.cwd());
    expect(admitted.decision).toBe("allow");
    p.permissionManager.setRules([{ pattern: "Bash(node --version)", action: "ask" }]);
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

  it("follows the sandbox-off policy, without a one-shot receipt, when the requested sandbox is unavailable", async () => {
    // A requested-but-unavailable sandbox is a plain shell under the exact-rule policy, as for the bash tool (owner 2026-10-25, unsandboxed shell exact-rule requirement); it records its fallback reason instead.
    setShellSandboxRequestedAtBoot(true);
    expect(getHostShellExecutionPlan()).toMatchObject({
      mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: false,
    });
    const p = policy("allow-once");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(JSON.parse(result.rawStdout).reason).toBe("received");
    // The hook's own approval is asked once, with no host-execution permit to bind.
    expect(p.requestAndWait).toHaveBeenCalledOnce();
    expect(p.requestAndWait).not.toHaveBeenCalledWith(expect.objectContaining({ hostShellExecutionPermitBinding: expect.anything() }));
  });

  it("consumes a real gate-approved host execution receipt before spawning", async () => {
    windowsPartialPlan();
    expect(getHostShellExecutionPlan()).toMatchObject({
      mode: "plain", fallbackReason: "windows-partial-shell-acl-unsafe", requiresExplicitUserApproval: true,
    });
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
    // The gate-signed approval is minted into one permit and consumed before spawn.
    expect(permits).toMatchObject({ minted: 1, consumed: [true] });
  });

  it("refuses a host execution receipt the approval gate did not sign", async () => {
    windowsPartialPlan();
    // An allow-once that did not come through the gate carries no valid receipt.
    const p = policy("allow-once");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result).toMatchObject({ decision: "deny", rawStdout: "", reason: expect.stringContaining("approval receipt is invalid") });
    expect(p.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ hostShellExecutionPermitBinding: expect.any(Object) }));
    expect(permits.consumed).toEqual([false]);
  });

  it("refuses to spawn after the admitted sandbox generation changes", async () => {
    const authorizeCommand = async () => {
      const plan = getHostShellExecutionPlan();
      setShellSandboxRequestedAtBoot(true);
      return { decision: "allow" as const, reason: "approved", plan };
    };
    expect(await runOneHookScript(hook, payload, { authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook shell execution policy changed during approval" });
  });

  it("denies an unattended hook a prefix rule does not admit, without raising a card (unsandboxed shell exact-rule requirement, I5)", async () => {
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow" }]);
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result.decision).toBe("deny");
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });
});
