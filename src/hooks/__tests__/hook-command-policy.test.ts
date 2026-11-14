import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createHookCommandAuthorizer, type HookCommandAuthorizer } from "../hook-command-policy.js";
import { runOneHookScript, type RunnableHook } from "../script-hook-runner.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import type { ScriptHookStdin } from "../script-hook-types.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../../permissions/approval-gate.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan,
  setActiveSandboxCapability, setShellSandboxRequestedAtBoot,
  __resetWindowsSandboxSubstrateForTest, getSandboxGeneration, setWindowsSandboxSubstrate,
} from "../../permissions/sandbox-capability.js";
import { windowsProxyOnlyCapability, windowsSubstrateFor, type WindowsSandboxPlanInputs } from "../../boot/steps/windows-sandbox-plan.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { resolveTurnExtensionPolicy, turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import type { ToolInvocationContext } from "../../permissions/reviewer/risk-classifier.js";
import { shellRuleCoversCommand } from "../../permissions/rules/shell-rule-approval.js";
import { saveApprovalCardRule } from "../../permissions/approval-rule-save.js";

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
const hook = { id: "config:PreToolUse#0.0", hookType: "pre" as const, hookPath: COMMAND, configDir: process.cwd(), command: ["node", COMMAND, "echo"] };
const payload: ScriptHookStdin = { hookType: "pre", toolName: "read_file", source: "builtin", category: "read",
  input: {}, sessionId: "hook-policy-session", trustOrigin: "user-keyboard" };
const roots: string[] = [];
const reviewerResources = new PermissionTestResources();
afterEach(async () => {
  sandboxedHost.active = false;
  plans.windowsPartial = false;
  __resetActiveSandboxCapabilityForTest();
  permits.minted = 0;
  permits.consumed.length = 0;
  vi.restoreAllMocks();
  __resetSandboxRequestedAtBootForTest();
  __resetWindowsSandboxSubstrateForTest();
  await reviewerResources.cleanup();
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
  const requestAndWait = vi.fn(async (_request: ApprovalRequestInput) => ({ requestId: "hook", choice }));
  return { root, permissionManager, requestAndWait,
    authorizeCommand: createHookCommandAuthorizer({ permissionManager, approvalGate: { requestAndWait } }) };
}

function reviewPolicy(p: ReturnType<typeof policy>, level: "low" | "medium" | "high") {
  const classify = vi.fn((_input: ToolInvocationContext) => ({ level, reason: "Hook command review" }));
  p.permissionManager.setMode("auto");
  setReviewerForTest(p.permissionManager, { classifier: { classify },
    cache: reviewerResources.makeVerdictCache(join(p.root, "hook-review.jsonl")) });
  return classify;
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

  it("uses the original project deny rules when execution is bound to another directory", async () => {
    const p = policy("allow-once");
    const projectDir = join(p.root, "project");
    const configDir = join(p.root, "config");
    mkdirSync(projectDir);
    mkdirSync(configDir);
    await p.permissionManager.addRulePersist({ pattern: "Bash(node *)", action: "deny" }, { kind: "project", projectCwd: projectDir });
    const result = await p.authorizeCommand({ ...hook, configDir }, payload, configDir, projectDir);
    expect(result.decision).toBe("deny");
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it("uses a normal shell card when strict policy asks", async () => {
    const p = policy("allow-once");
    p.permissionManager.setMode("strict");
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(p.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "bash", toolCategory: "shell", sessionId: "hook-policy-session",
      args: expect.objectContaining({ cwd: process.cwd(), hook: hook.id }),
      evaluationContext: expect.objectContaining({ executionCwd: process.cwd(), category: "shell" }),
    }));
    expect(p.requestAndWait.mock.calls[0]?.[0].forceExplicit).toBeUndefined();
    expect(p.requestAndWait.mock.calls[0]?.[0].allowedChoices).toBeUndefined();
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

  it.each([true, false])("honors eligible prefix rules on the actual shell route (sandboxed %s)", async (active) => {
    sandboxedHost.active = active;
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash('printf' *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const command = { ...hook, command: ["printf", "ready"] };
    expect((await p.authorizeCommand(command, payload, process.cwd())).decision).toBe("allow");
    expect(p.requestAndWait).not.toHaveBeenCalled();
    p.permissionManager.setRules([{ pattern: "Bash('printf' 'ready')", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const admitted = await p.authorizeCommand(command, payload, process.cwd());
    expect(admitted.decision, admitted.reason).toBe("allow");
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it("invalidates an automatic admission when an ask rule replaces its allow", async () => {
    const p = policy();
    // Permission changes invalidate the authority captured for this invocation.
    const pattern = "Bash('printf' 'ready')";
    p.permissionManager.setRules([{ pattern, action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const admitted = await p.authorizeCommand({ ...hook, command: ["printf", "ready"] }, payload, process.cwd());
    expect(admitted.decision).toBe("allow");
    p.permissionManager.setRules([{ pattern, action: "ask" }]);
    expect(admitted.assertAllowed).toBeTypeOf("function");
    expect(() => admitted.assertAllowed!()).toThrow("Hook command permission changed");
  });

  it("does not automatically admit an unsupported node option through an exact allow rule", async () => {
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash('node' '--version')", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const result = await p.authorizeCommand({ ...hook, command: ["node", "--version"] }, payload, process.cwd());
    expect(result.decision).toBe("deny");
    expect(p.requestAndWait).toHaveBeenCalledOnce();
  });

  it("requires approval for interpreter code even with a matching shell allow rule", async () => {
    const p = policy("allow-once");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
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
    manager.setTrustedRegistry([], [{ id: hook.id, event: "pre", source: "config", configDir: hook.configDir, command: hook.command, timeoutMs: 5000 }]);
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
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(JSON.parse(result.rawStdout).reason).toBe("received");
    // The hook's own approval is asked once, with no host-execution permit to bind.
    expect(p.requestAndWait).toHaveBeenCalledOnce();
    expect(p.requestAndWait).not.toHaveBeenCalledWith(expect.objectContaining({ hostShellExecutionPermitBinding: expect.anything() }));
  });

  describe.each(["boundary-link", "boundary-unlisted"] as const)("worker-only boot with an unverifiable boundary (%s)", (category) => {
    // Worker confinement on, shell scope off: boot publishes the boundary state while the shell intent stays false.
    function publish(): void {
      setShellSandboxRequestedAtBoot(false);
      setAveHomePrivacyAtBoot({ enforcement: "none", home: "C:\\Users\\alice\\.ave", reason: "ave-home-boundary-unverified", category });
    }
    afterEach(() => _resetAveHomePrivacyForTest());

    // A real authenticated gate answers each card once with `choice`.
    async function runWithGate(p: ReturnType<typeof policy>, choice: "allow-once" | "deny-once") {
      const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() };
      const gate = new ApprovalGate(wc as never);
      const authorizeCommand = createHookCommandAuthorizer({ permissionManager: p.permissionManager, approvalGate: gate });
      const pending = runOneHookScript(hook, payload, { authorizeCommand });
      const deadline = Date.now() + 3000;
      while (wc.send.mock.calls.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 1));
      const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
      expect(request?.nonce).toBeTruthy();
      expect(request).toMatchObject({ allowedChoices: ["allow-once", "deny-once"],
        executionPlan: { requestedSandbox: false, fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: true } });
      gate.resolve(request.id, { requestId: request.id, choice, nonce: request.nonce, hmac: request.hmac });
      const result = await pending;
      return { result, cards: wc.send.mock.calls.filter(([, sent]) => (sent as ApprovalRequest | undefined)?.nonce !== undefined).length };
    }

    function allowAll() {
      const p = policy();
      p.permissionManager.setMode("allow");
      p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
      return p;
    }

    it("runs the hook exactly once per gate-signed allow-once, and asks again next time", async () => {
      publish();
      const p = allowAll();
      const first = await runWithGate(p, "allow-once");
      expect(first.result.decision, first.result.reason).toBe("allow");
      expect(JSON.parse(first.result.rawStdout).reason).toBe("received");
      expect(first.cards).toBe(1);
      expect(permits).toMatchObject({ minted: 1, consumed: [true] });

      const second = await runWithGate(p, "allow-once");
      expect(second.cards).toBe(1);
      expect(second.result.decision, second.result.reason).toBe("allow");
      expect(permits).toMatchObject({ minted: 2, consumed: [true, true] });
    });

    // A plain command an ordinary exact rule can name, for the isolation check.
    const exactHook = { ...hook, command: ["printf", "ready"] };
    const exactHookRule = "Bash('printf' 'ready')";

    async function admitOnGate(p: ReturnType<typeof policy>, answer: "allow-session" | "deny-once", admitted: RunnableHook = hook, input: ScriptHookStdin = payload) {
      const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() };
      const gate = new ApprovalGate(wc as never);
      const authorizeCommand = createHookCommandAuthorizer({ permissionManager: p.permissionManager, approvalGate: gate });
      const pending = authorizeCommand(admitted, input, process.cwd());
      const deadline = Date.now() + 3000;
      while (wc.send.mock.calls.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 1));
      const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
      expect(request).toMatchObject({ allowedChoices: ["allow-once", "deny-once"],
        shellRule: { exactRule: null, sessionAllowed: true, persistentAllowed: false, denyAllowed: false, floorSessionOnly: true } });
      const snapshot = gate.getRequestSnapshot(request.id);
      if (!snapshot) throw new Error("request snapshot is missing");
      if (answer === "allow-session") {
        // The card can save nothing lasting.
        expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "always" },
          { decision: "allow", scope: "persistent", displayedVerdictAtApproval: snapshot.verdictAtApproval }, p.permissionManager))
          .toMatchObject({ ok: false, error: "one-shot-not-recordable" });
        // As the approval IPC does: the save is the card's own policy transition.
        const token = gate.beginApprovalRuleSave(request.id, p.permissionManager.getPolicyEpoch());
        expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "session" },
          { decision: "allow", scope: "session", displayedVerdictAtApproval: snapshot.verdictAtApproval }, p.permissionManager))
          .toMatchObject({ ok: true, scope: "session" });
        gate.completeApprovalRuleSave(token, p.permissionManager.getPolicyEpoch(), "session");
      }
      gate.resolve(request.id, { requestId: request.id, choice: answer === "allow-session" ? "allow-once" : "deny-once", nonce: request.nonce, hmac: request.hmac });
      return { result: await pending, gate, wc, authorizeCommand };
    }

    it("admits later hook commands in the same session without a card after allow for this session", async () => {
      publish();
      const p = allowAll();
      const first = await admitOnGate(p, "allow-session");
      expect(first.result.decision, first.result.reason).toBe("allow");
      expect(permits).toMatchObject({ minted: 1, consumed: [true] });

      // The interpreter fixture itself: no ordinary rule can name it, and the floor grant still covers it.
      const again = await runOneHookScript(hook, payload, { authorizeCommand: first.authorizeCommand });
      expect(again.decision, again.reason).toBe("allow");
      expect(JSON.parse(again.rawStdout).reason).toBe("received");
      expect(first.wc.send.mock.calls.filter(([, sent]) => (sent as ApprovalRequest | undefined)?.nonce !== undefined)).toHaveLength(1);
      expect(permits).toMatchObject({ minted: 2, consumed: [true, true] });
      // A different hook command in the same session: no card, its own permit.
      const other = await first.authorizeCommand(exactHook, payload, process.cwd());
      expect(other.decision, other.reason).toBe("allow");
      expect(first.wc.send.mock.calls.filter(([, sent]) => (sent as ApprovalRequest | undefined)?.nonce !== undefined)).toHaveLength(1);
      expect(permits.minted).toBe(3);

      // Headless still denies; another conversation, the ended conversation and a fresh permission state (a restart) ask again.
      const headless = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
        () => first.authorizeCommand(hook, payload, process.cwd()));
      expect(headless.decision).toBe("deny");
      expect((await admitOnGate(p, "deny-once", exactHook, { ...payload, sessionId: "hook-policy-other-session" })).result.decision).toBe("deny");
      p.permissionManager.endSession("hook-policy-session");
      expect((await admitOnGate(p, "deny-once", exactHook)).result.decision).toBe("deny");
      expect((await admitOnGate(allowAll(), "deny-once")).result.decision).toBe("deny");
    });

    it("does not pass the floor with an ordinary session allow made earlier", async () => {
      const p = allowAll();
      p.permissionManager.addSessionRule("hook-policy-session", exactHookRule);
      publish();
      expect((await admitOnGate(p, "deny-once", exactHook)).result.decision).toBe("deny");
      expect(permits.consumed).toEqual([]);
    });

    it("does not run the hook on deny-once", async () => {
      publish();
      const { result } = await runWithGate(allowAll(), "deny-once");
      expect(result).toMatchObject({ decision: "deny", rawStdout: "" });
      expect(permits.consumed).toEqual([]);
    });

    it("denies the hook headless without a card", async () => {
      publish();
      const p = allowAll();
      const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
        () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
      expect(result).toMatchObject({ decision: "deny", rawStdout: "" });
      expect(p.requestAndWait).not.toHaveBeenCalled();
    });
  });

  it("keeps the ordinary sandbox-off hook policy outside the boundary state", async () => {
    setShellSandboxRequestedAtBoot(false);
    expect(getHostShellExecutionPlan()).toMatchObject({ fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: false });
    const p = policy();
    p.permissionManager.setMode("allow");
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(p.requestAndWait).not.toHaveBeenCalled();
    expect(permits.minted).toBe(0);
  });

  it("consumes a real gate-approved host execution receipt before spawning", async () => {
    windowsPartialPlan();
    expect(getHostShellExecutionPlan()).toMatchObject({
      mode: "plain", fallbackReason: "windows-partial-shell-acl-unsafe", requiresExplicitUserApproval: true,
    });
    const p = policy();
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
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
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result).toMatchObject({ decision: "deny", rawStdout: "", reason: expect.stringContaining("approval receipt is invalid") });
    expect(p.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ hostShellExecutionPermitBinding: expect.any(Object) }));
    expect(permits.consumed).toEqual([false]);
  });

  it.each(["approval", "authority refresh"])("keeps an approved hook on its captured shell route when the stamp succeeds during %s", async stage => {
    const input: WindowsSandboxPlanInputs = {
      shellRequested: true, shellLocalNetworkAccess: true, workerRequested: true, srtWinReady: true, windowsBuild: null,
      mxc: { state: "unavailable", reason: "tier-unsupported" },
    };
    plans.windowsPartial = true;
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability(windowsProxyOnlyCapability());
    setWindowsSandboxSubstrate(windowsSubstrateFor(input, "proxy-only"));
    const capturedGeneration = getSandboxGeneration();
    const promote = (): void => {
      windowsPartialPlan();
      setWindowsSandboxSubstrate(windowsSubstrateFor(input, "srt-win"));
    };
    const p = policy();
    p.permissionManager.setMode("strict");
    const entered = deferred<ApprovalRequest>();
    const wc = { isDestroyed: () => false, send: (_channel: string, request: ApprovalRequest) => entered.resolve(request) };
    const gate = new ApprovalGate(wc as never);
    const authorize = createHookCommandAuthorizer({ permissionManager: p.permissionManager, approvalGate: gate });
    const authorizeCommand: HookCommandAuthorizer = async (...args) => {
      const admission = await authorize(...args);
      return { ...admission, refreshAllowed: async () => {
        await admission.refreshAllowed?.();
        if (stage === "authority refresh") promote();
      } };
    };
    const running = runOneHookScript(hook, payload, { authorizeCommand });
    const request = await entered.promise;
    expect(request.executionPlan).toMatchObject({ platform: "win32", mode: "plain", substrate: "none", requiresExplicitUserApproval: true });
    if (stage === "approval") promote();
    gate.resolve(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });

    const result = await running;
    expect(getSandboxGeneration()).not.toBe(capturedGeneration);
    expect(getHostShellExecutionPlan()).toMatchObject({ identity: request.executionPlan?.identity, mode: "plain", substrate: "none" });
    expect(result.decision, result.reason).toBe("allow");
    expect(JSON.parse(result.rawStdout).reason).toBe("received");
    expect(permits).toMatchObject({ minted: 1, consumed: [true] });
  });

  it("refuses to spawn after the admitted shell route changes", async () => {
    const authorizeCommand = async () => {
      const plan = getHostShellExecutionPlan();
      setShellSandboxRequestedAtBoot(true);
      return { decision: "allow" as const, reason: "approved", plan };
    };
    expect(await runOneHookScript(hook, payload, { authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook shell execution policy changed during approval" });
  });

  it("rechecks the admitted shell route after the final fresh authority refresh", async () => {
    const assertAllowed = vi.fn();
    const authorizeCommand = async () => ({
      decision: "allow" as const, reason: "approved", plan: getHostShellExecutionPlan(), assertAllowed,
      // The shell policy changes while the final pre-spawn probe is pending.
      refreshAllowed: async () => { setShellSandboxRequestedAtBoot(true); },
    });
    expect(await runOneHookScript(hook, payload, { authorizeCommand }))
      .toMatchObject({ decision: "deny", rawStdout: "", reason: "hook shell execution policy changed before spawn" });
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  it("denies an unattended unresolved hook command in the default mode without raising a card", async () => {
    const p = policy();
    p.permissionManager.setMode("default");
    p.permissionManager.setRules([{ pattern: "Bash(node *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result.decision).toBe("deny");
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["low", "medium"] as const)("reviews an unattended hook before allowing its %s verdict", async (level) => {
    const p = policy();
    const classify = reviewPolicy(p, level);
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result.decision, result.reason).toBe("allow");
    expect(JSON.parse(result.rawStdout).reason).toBe("received");
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toMatchObject({ toolName: "bash", finalInput: {
      command: expect.stringContaining(COMMAND), cwd: process.cwd(),
    } });
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it("denies unattended high-risk hooks with the no-retry message after review", async () => {
    const p = policy("allow-once");
    const classify = reviewPolicy(p, "high");
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, true),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result).toMatchObject({ decision: "deny", rawStdout: "", reason: `hook command denied: ${NO_APPROVER_MESSAGE}` });
    expect(classify).toHaveBeenCalledOnce();
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it("uses a normal owner-away card after a high verdict", async () => {
    const p = policy("allow-once");
    const classify = reviewPolicy(p, "high");
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, false, { ownerUnattended: true }),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result.decision, result.reason).toBe("allow");
    expect(classify).toHaveBeenCalledOnce();
    const request = p.requestAndWait.mock.calls[0]?.[0];
    expect(request?.ownerUnattended).toBe(true);
    expect(request?.forceExplicit).toBeUndefined();
    expect(request?.allowedChoices).toBeUndefined();
  });

  it("keeps other-principal hook commands one-shot and outside reviewer authority", async () => {
    const p = policy("allow-once");
    const classify = reviewPolicy(p, "low");
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, false, {
      floor: { code: "other-principal", reason: "External content influenced this turn" },
    }), () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result.decision, result.reason).toBe("allow");
    expect(classify).not.toHaveBeenCalled();
    expect(p.requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ forceExplicit: true,
      allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false }));
  });

  it("uses action-bound native permits for a normal allow-mode decision", async () => {
    windowsPartialPlan();
    const p = policy();
    p.permissionManager.setMode("allow");
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result.decision, result.reason).toBe("allow");
    expect(p.requestAndWait).not.toHaveBeenCalled();
    expect(permits).toMatchObject({ minted: 1, consumed: [true] });
  });

  it("refuses an automatic hook decision after policy changes during review", async () => {
    const p = policy("allow-once");
    const classify = reviewPolicy(p, "low");
    classify.mockImplementationOnce(() => {
      p.permissionManager.setRules([{ pattern: "bash", action: "deny" }]);
      return { level: "low", reason: "Earlier policy allowed" };
    });
    const result = await runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand });
    expect(result).toMatchObject({ decision: "deny", rawStdout: "" });
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });

  it("observes cancellation during review and at the final spawn assertion", async () => {
    const p = policy("allow-once");
    const controller = new AbortController();
    const classify = reviewPolicy(p, "low");
    classify.mockImplementationOnce(() => {
      controller.abort();
      return { level: "low", reason: "Completed after cancellation" };
    });
    const result = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, false, { abortSignal: controller.signal }),
      () => runOneHookScript(hook, payload, { authorizeCommand: p.authorizeCommand }));
    expect(result).toMatchObject({ decision: "deny", rawStdout: "" });
    expect(p.requestAndWait).not.toHaveBeenCalled();
    const next = new AbortController();
    p.permissionManager.setMode("allow");
    const admitted = await turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(undefined, false, { abortSignal: next.signal }),
      () => p.authorizeCommand(hook, payload, process.cwd()));
    expect(admitted.decision).toBe("allow");
    next.abort();
    expect(() => admitted.assertAllowed!()).toThrow("Hook command permission changed");
  });

  it("offers an eligible prefix rule through the existing signed shell card", async () => {
    const p = policy();
    const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const gate = new ApprovalGate(wc as never);
    const authorize = createHookCommandAuthorizer({ permissionManager: p.permissionManager, approvalGate: gate });
    const pending = authorize({ ...hook, command: ["printf", "ready"] }, payload, process.cwd());
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());
    const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
    expect(request.shellRule).toMatchObject({ persistentAllowed: true, sessionAllowed: true });
    expect(shellRuleCoversCommand("bash", "Bash('printf' *)", "allow", "'printf' 'ready'", process.cwd())).toBe(true);
    gate.resolve(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });
    expect((await pending).decision).toBe("allow");
  });

  it.each([{ revoked: false, transport: "bridge" }, { revoked: true, transport: "bridge" }, { revoked: false, transport: "tailnet" }, { revoked: true, transport: "tailnet" }])("rechecks a bound controller after an actual pending hook card: %j", async ({ revoked, transport }) => {
    const p = policy();
    p.permissionManager.setMode("strict");
    const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const gate = new ApprovalGate(wc as never);
    const requestAndWait = vi.spyOn(gate, "requestAndWait");
    const authorizeCommand = createHookCommandAuthorizer({ permissionManager: p.permissionManager, approvalGate: gate });
    let current = true;
    let ownerAvailable = true;
    const authority = transport === "tailnet" ? bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:hook-controller", pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" }, pairedShareGuard: { isCurrent: () => current, refreshCurrent: async () => { current = ownerAvailable; return current; } } }, payload.sessionId) : bindRemoteControllerToSession({
      kind: "platform-bridge", actorId: "hook-controller",
      bridgeBinding: { bridgeId: "bridge", bridgeEpoch: 1, routeId: "route", routeEpoch: 1, scope: "scope" },
      bridgeGuard: { isCurrent: () => current },
    }, payload.sessionId);
    const pending = turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(authority),
      () => runOneHookScript(hook, payload, { authorizeCommand }));
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());
    const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ remoteControllerAuthority: authority, remoteControllerOrigin: transport === "tailnet" ? "tailnet-controller" : "platform-bridge" }));
    expect(gate.pendingCount).toBe(1);
    if (revoked) { if (transport === "tailnet") ownerAvailable = false; else current = false; }
    await gate.resolveWithFreshIdentity(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });
    const result = await pending;
    expect(result.decision).toBe(revoked ? "deny" : "allow");
    if (revoked) expect(result.rawStdout).toBe("");
    expect(gate.pendingCount).toBe(0);
  });

  it("rejects a newly protected symlink target after review", async () => {
    const p = policy("allow-once");
    const ordinary = join(p.root, "ordinary.txt");
    const alias = join(p.root, "alias.txt");
    const control = join(p.root, ".git", "config");
    mkdirSync(join(p.root, ".git"));
    writeFileSync(ordinary, "ordinary");
    writeFileSync(control, "protected");
    symlinkSync(ordinary, alias);
    const classify = reviewPolicy(p, "low");
    classify.mockImplementationOnce(() => {
      unlinkSync(alias);
      symlinkSync(control, alias);
      return { level: "low", reason: "Reviewed the original target" };
    });
    const result = await p.authorizeCommand({ ...hook, command: ["cat", alias] }, payload, p.root);
    expect(result).toMatchObject({ decision: "deny", reason: "Hook command effect changed during approval" });
    expect(classify).toHaveBeenCalledOnce();
    expect(p.requestAndWait).not.toHaveBeenCalled();
  });
});
