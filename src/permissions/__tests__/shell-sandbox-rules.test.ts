import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
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
import { AuditLogger } from "../../audit/audit-logger.js";
import { flushSandboxAudit } from "../../audit/sandbox-audit-sink.js";

let dir: string;
let manager: PermissionManager;
// Audit writes are queued, not awaited, by the code under test; teardown must
// drain them before removing the directory they write into.
const auditLoggers: AuditLogger[] = [];
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
afterEach(async () => {
  await Promise.all(auditLoggers.splice(0).map((logger) => logger.close()));
  await flushSandboxAudit();
  __resetSessionStoreForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function check(command: string, runsSandboxed: boolean, extra: { headless?: boolean; sessionId?: string } = {}) {
  return manager.checkDetailed("bash", "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect: "bash", command, cwd: dir },
    shellExecution: { runsSandboxed },
    ...extra,
  });
}

describe("shell confinement and escape rules", () => {
  it("auto-allows a confined call and asks for the same plain call", () => {
    expect(check("printf ready", true)).toMatchObject({ decision: "allow" });
    expect(check("printf ready", false)).toMatchObject({ decision: "ask" });
    manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    expect(check("printf ready", false)).toMatchObject({ decision: "allow", layer: 3 });
  });

  // Owner 2026-10-25 (unsandboxed shell exact-rule requirement): without a sandbox for this command only an exact Bash(<command>) rule runs it unasked, even on a host whose sandbox works for other commands.
  it.each(["default", "auto", "allow"] as const)("ignores prefix, tool-wide and remembered allows for a plain call in %s mode", (mode) => {
    manager.setMode(mode);
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }, { pattern: "bash", action: "allow" }]);
    expect(check("printf ready", false)).toMatchObject({ decision: "ask", layer: 6 });
    expect(check("printf ready", false).reviewer).toBeUndefined();
    manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    expect(check("printf ready", false)).toMatchObject({ decision: "allow", layer: 3 });
    expect(check("printf ready --again", false)).toMatchObject({ decision: "ask" });
    expect(check("printf other", false)).toMatchObject({ decision: "ask" });
  });

  it("keeps a prefix rule for a confined call", () => {
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
    expect(check("printf ready", true)).toMatchObject({ decision: "allow" });
  });

  it("denies a headless plain call that no exact rule covers, and runs one that an exact rule covers (unsandboxed shell exact-rule requirement, I5)", () => {
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
    expect(check("printf ready", false, { headless: true })).toMatchObject({ decision: "deny", layer: 6 });
    expect(check("printf ready", false, { headless: true }).reviewer).toBeUndefined();
    manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    expect(check("printf ready", false, { headless: true })).toMatchObject({ decision: "allow", layer: 3 });
  });

  it("applies a This session rule to its conversation only, until the conversation ends (five-choice shell card)", () => {
    manager.addSessionShellRule("conversation-a", "Bash(printf ready)");
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "allow", layer: 3 });
    expect(check("printf ready", false, { sessionId: "conversation-b" })).toMatchObject({ decision: "ask" });
    expect(check("printf ready", false)).toMatchObject({ decision: "ask" });
    expect(check("printf other", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "ask" });
    expect(manager.endSession("conversation-a")).toBe(true);
    expect(check("printf ready", false, { sessionId: "conversation-a" })).toMatchObject({ decision: "ask" });
    expect(manager.listSessionShellRules("conversation-a")).toEqual([]);
  });

  it.each(["Bash(printf *)", "bash", "WebFetch(domain:example.com)"])("refuses to hold %s as a session shell rule", (pattern) => {
    expect(() => manager.addSessionShellRule("conversation-a", pattern)).toThrow();
    expect(manager.listSessionShellRules("conversation-a")).toEqual([]);
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

  it("never routes an unresolved plain call to the automatic reviewer (unsandboxed shell exact-rule requirement)", () => {
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("medium");
    const result = check("printf ready", false);
    expect(result).toMatchObject({ decision: "ask" });
    expect(result.reviewer).toBeUndefined();
    expect(check("printf ready", true).reviewer).toBeUndefined();
  });
});

function executorWithDock(options: { executionMode?: "host" | "sandbox"; headless?: boolean } = {}) {
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
  const auditLogger = new AuditLogger();
  auditLoggers.push(auditLogger);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
  const executionMode = options.executionMode ?? "host";
  const input = executionMode === "host"
    ? { command: "printf ready", executionMode, justification: "Read the host environment" }
    : { command: "printf ready" };
  const permissionContext = options.headless === true ? { ...userPermissionContext(), headless: true } : userPermissionContext();
  const run = () => runWithToolExecutionCwd(dir, () => executor.executeAll([{ id: "retry", name: "bash", input }], { sessionId: "conversation", permissionContext }));
  return { run, requests, input, send };
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
    // An explicit host request without a rule goes to the card unreviewed,
    // and an unreviewed explicit host card is one-shot, so it offers no rule.
    expect(requests[0]?.shellRule).toMatchObject({ sessionAllowed: false, persistentAllowed: false });
    expect(requests[0]).not.toHaveProperty("shellExecution");
    expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
    expect(getHostShellExecutionPlan().mode).toBe(planBefore.mode);
    expect(check("printf later", true).decision).toBe("allow");
  });

  it("uses an exact rule to authorize an actual host spawn without a dock receipt, and asks under a prefix", async () => {
    manager.setRules([{ pattern: "Bash(printf *)", action: "allow" }]);
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
    manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests).toHaveLength(1);
  });

  it("asks for an explicit host request while the sandbox is unavailable, until an exact rule approves it", async () => {
    __resetActiveSandboxCapabilityForTest();
    const { run, requests } = executorWithDock();
    expect((await run())[0]).toMatchObject({ content: "ready" });
    expect(requests[0]?.shellRule).toMatchObject({ sessionAllowed: false, persistentAllowed: false });
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

  function lowReviewer() {
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("medium");
    const classifier = { classify: vi.fn(async (): Promise<{ level: "low" | "high"; reason: string }> => ({ level: "low", reason: "bounded host effect" })) };
    const cache = new VerdictCache(join(dir, "review-cache.jsonl"));
    setReviewerForTest(manager, { classifier, cache, deferredQueue: new DeferredQueue(join(dir, "deferred.jsonl")) });
    return { classifier, cache };
  }

  // Owner 2026-10-25 (unsandboxed shell exact-rule requirement, superseding I3's normal-rule path): an unavailable sandbox never lets a reviewer verdict run a plain call; the card asks whatever the reviewer would say.
  it.each(["low", "high"] as const)("asks for a plain call while the sandbox is unavailable without consulting a %s reviewer", async (level) => {
    setActiveSandboxCapability({ kind: "none", confidence: "verified", platform: process.platform, reason: "fixture sandbox unavailable" });
    const { classifier, cache } = lowReviewer();
    classifier.classify.mockImplementation(async () => ({ level, reason: level === "high" ? "ambiguous host effect" : "bounded host effect" }));
    try {
      const { run, requests } = executorWithDock({ executionMode: "sandbox" });
      expect((await run())[0]).toMatchObject({ content: "ready" });
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests.every((request) => request.executionPlan?.mode === "plain")).toBe(true);
    } finally { await cache.flush(); }
  });

  // An explicit host request runs on a matching exact allow rule, otherwise it asks with the host-execution warning. A low reviewer verdict is no rule.
  it("does not let a low reviewer verdict stand in for the card on an explicit host request", async () => {
    const { classifier, cache } = lowReviewer();
    try {
      const { run, requests } = executorWithDock();
      expect((await run())[0]).toMatchObject({ content: "ready" });
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.executionPlan).toMatchObject({ mode: "plain", executionRequest: "host", requiresExplicitUserApproval: true });
    } finally { await cache.flush(); }
  });

  // I5 (owner 2026-10-16): with nobody to answer, an explicit host request is denied, with or without a matching rule, and no card is raised.
  it.each([false, true])("denies a headless explicit host request without asking (matching rule %s)", async (withRule) => {
    if (withRule) manager.setRules([{ pattern: "Bash(printf ready)", action: "allow" }]);
    const { classifier, cache } = lowReviewer();
    try {
      const { run, requests, send } = executorWithDock({ headless: true });
      const [result] = await run();
      expect(result).toMatchObject({ is_error: true });
      expect(result?.content).toMatch(/headless|background run|백그라운드/i);
      expect(result?.content).not.toContain("ready\n");
      expect(requests).toEqual([]);
      expect(send).not.toHaveBeenCalledWith("ave:approval:request", expect.anything());
      expect(classifier.classify).not.toHaveBeenCalled();
    } finally { await cache.flush(); }
  });
});
