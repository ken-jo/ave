import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionManager, type PermissionCheckContext, type ReviewerDispatchResult } from "../permission-manager.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { JudgeContractError } from "../judge/judge-contract.js";
import { issueHostNetworkSubject } from "../host-network-subject.js";
import { DisabledRiskClassifier, RuleBasedRiskClassifier } from "../reviewer/risk-classifier.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

// The expected behavior comes from docs/architecture/permission-decision-tree.md.
describe("permission manager pipeline integration", () => {
  let directory: string;
  let manager: PermissionManager;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "permission-pipeline-"));
    manager = new PermissionManager(join(directory, "permissions.json"));
  });
  afterEach(() => cleanupTmpDir(directory));

  function pauseSession(sessionId: string): void {
    for (let index = 0; index < 3; index += 1) manager.getJudgeBreaker().record(sessionId, "ask", `block-${index}`);
  }

  it("rechecks late pauses centrally and clears their evidence only for a new turn", () => {
    const sessionId = "late-pause";
    const initial = manager.checkDetailed("read_file", "builtin", "read", undefined, { sessionId });
    expect(initial.decision).toBe("allow");
    pauseSession(sessionId);
    const paused = manager.recheckPermission(initial);
    expect(paused).toMatchObject({ decision: "ask", reasonCode: "automation-paused", pipelineRequest: { sessionId, automationPause: { kind: "consecutive" } } });
    expect(paused.forceModal).toBeUndefined();
    expect(paused.reviewer).toBeUndefined();
    expect(manager.checkDetailed("read_file", "builtin", "read", undefined, { sessionId: "other-session" }).decision).toBe("allow");
    manager.beginPermissionTurn(sessionId);
    const resumed = manager.recheckPermission(paused);
    expect(resumed.decision).toBe("allow");
    expect(resumed.pipelineRequest).not.toHaveProperty("automationPause");
  });

  it("normalizes network session pauses and denies without an approver", async () => {
    manager.setMode("allow");
    const sessionId = "network-pause";
    pauseSession(sessionId);
    const evaluated = await manager.checkNetworkPermission({ host: "example.test", port: 443, source: "builtin", network: "public" }, { sessionId, headless: true });
    expect(evaluated.permission).toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE, pipelineRequest: { sessionId, automationPause: { kind: "consecutive" } } });
  });

  it("keeps deny and mandatory floor precedence during a paused turn", () => {
    manager.setMode("allow");
    const sessionId = "priority-pause";
    pauseSession(sessionId);
    manager.setRules([{ pattern: "deny_probe", action: "deny" }]);
    const denied = manager.checkDetailed("deny_probe", "builtin", "write", undefined, { sessionId });
    expect(manager.recheckPermission(denied)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
    const floor = manager.checkDetailed("floor_probe", "builtin", "write", undefined, { sessionId, floor: { code: "protected-path", reason: "Control file" } });
    expect(manager.recheckPermission(floor)).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
  });

  it("requires issued recheck identity and clears reviewer metadata after an epoch change", () => {
    manager.setMode("auto");
    const pending = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "review-session" });
    const verdict = { level: "low" as const, reason: "Reviewed" };
    const allowed = manager.resolveReviewedPermission(pending, { verdict, outcome: "fresh", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } });
    expect(() => manager.recheckPermission({ ...allowed })).toThrow(JudgeContractError);
    const current = manager.recheckPermission(allowed);
    expect(current.reviewer).toEqual(allowed.reviewer);
    expect(() => manager.recheckPermission(allowed)).toThrow(JudgeContractError);
    manager.setMode("strict");
    const stale = manager.recheckPermission(current);
    expect(stale).toMatchObject({ decision: "deny", reasonCode: "policy-changed" });
    expect(stale.reviewer).toBeUndefined();
  });

  it("allows ordinary reads in the initial strict mode", () => {
    expect(manager.getMode()).toBe("strict");
    expect(manager.checkDetailed("read_file", "builtin", "read").decision).toBe("allow");
  });

  it.each(["strict", "default", "auto", "allow"] as const)("allows declared read-only external tools in %s", (mode) => {
    manager.setMode(mode);
    expect(manager.checkDetailed("lookup", "mcp", "write", undefined, { mcpReadOnlyHint: true }).decision).toBe("allow");
  });

  it("remembers ordinary external tools per tool", () => {
    manager.setMode("default");
    const first = manager.checkDetailed("remote_lookup", "mcp", "read");
    expect(first.decision).toBe("ask");
    manager.setRules([{ pattern: "remote_lookup", action: "allow" }]);
    expect(manager.checkDetailed("remote_lookup", "mcp", "read").decision).toBe("allow");
    expect(manager.checkDetailed("remote_write", "mcp", "write").decision).toBe("ask");
  });

  it("denies unreadable policy even for reads and allow mode", () => {
    manager.setMode("allow");
    expect(manager.checkDetailed("read_file", "builtin", "read", undefined, { permissionStoreError: "Invalid permission store" })).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
  });

  it("keeps deny rules before principal floors", () => {
    manager.setRules([{ pattern: "write_file", action: "deny" }]);
    expect(manager.checkDetailed("write_file", "builtin", "write", undefined, { floor: { code: "other-principal", reason: "Remote origin" } })).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
  });

  it("keeps in-project checkpoint writes automatic only outside strict mode", () => {
    const context: PermissionCheckContext = { fileWritePolicy: { insideProject: true, checkpointAvailable: true, directoryApproved: false } };
    expect(manager.checkDetailed("write_file", "builtin", "write", undefined, context).decision).toBe("ask");
    manager.setMode("default");
    expect(manager.checkDetailed("write_file", "builtin", "write", undefined, context)).toMatchObject({ decision: "allow", requiresCodeCheckpoint: true });
  });

  it("asks once for outside writes and accepts the invocation folder approval", () => {
    manager.setMode("default");
    const context: PermissionCheckContext = { fileWritePolicy: { insideProject: false, checkpointAvailable: false, directoryApproved: false } };
    expect(manager.checkDetailed("write_file", "builtin", "write", undefined, context)).toMatchObject({ decision: "ask" });
    context.fileWritePolicy!.directoryApproved = true;
    expect(manager.checkDetailed("write_file", "builtin", "write", undefined, context).decision).toBe("allow");
  });

  it("allows a saved prefix rule on the host shell", () => {
    manager.setMode("default");
    manager.setRules([withCurrentShellRuleVersion({ pattern: "Bash(echo *)", action: "allow" })]);
    expect(manager.checkDetailed("bash", "builtin", "shell", undefined, {
      ruleSubject: { kind: "shell", dialect: "bash", command: "echo hello", cwd: directory },
      shellExecution: { runsSandboxed: false },
    })).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  });

  it("allows proven sandbox reads but asks for the same host command", () => {
    const context: PermissionCheckContext = { ruleSubject: { kind: "shell", dialect: "bash", command: "git status", cwd: directory }, shellExecution: { runsSandboxed: true } };
    const readResult = manager.checkDetailed("bash", "builtin", "shell", undefined, context);
    expect(readResult.decision).toBe("allow");
    context.shellExecution = { runsSandboxed: false };
    expect(manager.checkDetailed("bash", "builtin", "shell", undefined, context).decision).toBe("ask");
  });

  it("asks normally for a secret read and forces protected control paths", () => {
    manager.setMode("default");
    const path = (name: string) => ({ lexical: join(directory, name), canonical: join(directory, name), effect: "read" as const });
    expect(manager.checkDetailed("read_file", "builtin", "read", undefined, { paths: [path(".env")] })).toMatchObject({ decision: "ask", reasonCode: "secret-read" });
    expect(manager.checkDetailed("read_file", "builtin", "read", undefined, { paths: [path(".git/config")] })).toMatchObject({ decision: "ask", forceModal: true });
  });

  it("routes headless auto through review and denies a high fallback without retry", () => {
    manager.setMode("auto");
    const result = manager.checkDetailed("web_fetch", "builtin", "network", undefined, { headless: true });
    expect(result.reviewer?.route).toBe("headless");
    const review: ReviewerDispatchResult = { verdict: { level: "high", reason: "Needs a human" }, outcome: "fresh", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } };
    expect(manager.resolveReviewedPermission(result, review)).toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
  });

  it("keeps manual reruns fresh despite remembered approval", () => {
    manager.setMode("allow");
    manager.setRules([{ pattern: "web_fetch", action: "allow" }]);
    const result = manager.checkDetailed("web_fetch", "builtin", "network", undefined, { manualRerun: true });
    expect(result).toMatchObject({ decision: "ask", forceModal: true });
    expect(manager.resolveRememberedPermission(result, "Prior approval").decision).toBe("ask");
  });
  it("forces critical deletion while ordinary project removal follows its mode", () => {
    manager.setMode("allow");
    const check = (command: string) => manager.checkDetailed("bash", "builtin", "shell", undefined, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd: directory },
      shellExecution: { runsSandboxed: true },
    });
    expect(check('rm -rf "' + directory + '"')).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "critical-delete" });
    expect(check("rm -rf ./generated")).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
  });

  it("rechecks approval-memory authority after a concurrent rule change", () => {
    manager.setMode("default");
    const pending = manager.checkDetailed("web_fetch", "builtin", "network");
    manager.setRules([{ pattern: "web_fetch", action: "deny" }]);
    expect(manager.resolveRememberedPermission(pending, "Previous approval")).toMatchObject({ decision: "deny", reasonCode: "policy-changed" });
  });

  it("rejects forged review requests and consumes review authority once", () => {
    manager.setMode("auto");
    const pending = manager.checkDetailed("web_fetch", "builtin", "network");
    const review: ReviewerDispatchResult = { verdict: { level: "low", reason: "Reviewed" }, outcome: "fresh", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } };
    expect(() => manager.resolveReviewedPermission({ ...pending }, review)).toThrow("issued pipeline request");
    expect(manager.resolveReviewedPermission(pending, review).decision).toBe("allow");
    expect(() => manager.resolveReviewedPermission(pending, review)).toThrow("issued pipeline request");
  });

  it.each([undefined, null, {}, { judged: "false" }, { judged: false, skip: "unknown" }, { judged: true, decision: "allow" }])(
    "rejects invalid judge evidence before resolving a reviewed permission: %j", judge => {
      manager.setMode("auto");
      const pending = manager.checkDetailed("web_fetch", "builtin", "network");
      const review = { verdict: { level: "low", reason: "Incomplete evidence cannot authorize" }, outcome: "fresh", cacheReason: "miss-not-found", judge };
      expect(() => manager.resolveReviewedPermission(pending, review as ReviewerDispatchResult)).toThrow(JudgeContractError);
    },
  );

  it.each(["auto", "allow"] as const)("keeps credential-bearing fetches forced in %s despite allow rules", async (mode) => {
    await manager.ensureProjectRulesLoaded(directory);
    manager.setMode(mode);
    manager.setRules([{ pattern: "web_fetch", action: "allow" }]);
    const result = manager.checkDetailed("web_fetch", "builtin", "network", undefined, {
      projectRulesCwd: directory,
      ruleSubject: { kind: "webfetch", url: "https://example.test/?api_key=sk-abc123def456ghi789jkl012mno" },
    });
    expect(result).toMatchObject({ decision: "ask", reasonCode: "exfiltration", forceModal: true });
    expect(result.reviewer).toBeUndefined();
    const ordinary = manager.checkDetailed("web_fetch", "builtin", "network", undefined, {
      projectRulesCwd: directory,
      ruleSubject: { kind: "webfetch", url: "https://example.test/docs" },
    });
    expect(ordinary).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
  });

  it("retains plugin provenance while screening the actual fetch destination", async () => {
    await manager.ensureProjectRulesLoaded(directory);
    manager.setMode("allow");
    const result = manager.checkDetailed("effect_hostFetch", "plugin", "network", undefined, {
      projectRulesCwd: directory,
      ruleSubject: issueHostNetworkSubject({ url: "https://example.test/?api_key=sk-abc123def456ghi789jkl012mno" }),
    });
    expect(result).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "exfiltration" });
    expect(result.pipelineRequest?.tool.source).toBe("plugin");
  });

  it("treats an unavailable approval surface as headless while retaining auto review", () => {
    manager.setMode("default");
    expect(manager.checkDetailed("web_fetch", "builtin", "network", undefined, {
      headless: false, approvalSurface: "unavailable",
    })).toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
    manager.setMode("auto");
    const result = manager.checkDetailed("web_fetch", "builtin", "network", undefined, {
      headless: false, approvalSurface: "unavailable",
    });
    expect(result.reviewer?.route).toBe("headless");
    expect(result.pipelineRequest?.headless).toBe(true);
  });

  it("rejects copied and fabricated network subjects on extension effects", async () => {
    await manager.ensureProjectRulesLoaded(directory);
    const issued = issueHostNetworkSubject({ url: "https://example.test/" });
    expect(Object.isFrozen(issued)).toBe(true);
    for (const ruleSubject of [{ ...issued }, { kind: "webfetch" as const, url: issued.url }]) {
      expect(() => manager.checkDetailed("effect_hostFetch", "plugin", "network", undefined, {
        projectRulesCwd: directory, ruleSubject,
      })).toThrow("does not match the tool source");
    }
    expect(manager.checkDetailed("effect_hostFetch", "plugin", "network", undefined, {
      projectRulesCwd: directory, ruleSubject: issued,
    }).decision).toBe("ask");
  });

  it.each([false, true])("treats disabled review as unavailable rather than a low-risk assessment (headless %s)", async (headless) => {
    manager.setMode("auto");
    const cache = new VerdictCache(join(directory, "disabled-review.jsonl"));
    setReviewerForTest(manager, { classifier: new DisabledRiskClassifier(), cache });
    const pending = manager.checkDetailed("web_fetch", "builtin", "network", undefined, { headless });
    const review = await manager.dispatchReviewer("web_fetch", {
      invocationId: "disabled-review", sessionId: "disabled-session", source: "builtin", category: "network",
      pathFields: [], finalInput: { url: "https://example.test/" }, executionCwd: directory,
      allowedDirectories: [directory], sensitivePathsAdjacent: [], trustOrigin: "user-keyboard", permissionDecision: pending,
    }, undefined, { lane: headless ? "headless" : "foreground-auto" });
    expect(review.outcome).toBe("unavailable");
    const result = manager.resolveReviewedPermission(pending, review);
    expect(result.decision).toBe(headless ? "deny" : "ask");
    expect(result.forceModal).toBeUndefined();
    if (headless) expect(result.reason).toBe(NO_APPROVER_MESSAGE);
    await cache.flush();
  });

  it("assesses a remembered scope in strict mode without granting a new execution decision", async () => {
    const cache = new VerdictCache(join(directory, "scope-review.jsonl"));
    setReviewerForTest(manager, { classifier: new RuleBasedRiskClassifier(), cache });
    const pending = manager.checkDetailed("web_fetch", "builtin", "network");
    expect(pending.decision).toBe("ask");
    expect(pending.reviewer).toBeUndefined();
    const review = await manager.dispatchReviewer("web_fetch", {
      invocationId: "scope-assessment", sessionId: "scope-session", source: "builtin", category: "network",
      pathFields: [], finalInput: { url: "https://example.test/docs" },
      executionCwd: directory, allowedDirectories: [directory], sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
    }, undefined, { lane: "foreground-auto", purpose: "approval-scope" });
    expect(review.verdict.level).toBe("low");
    expect(review.judge).toMatchObject({ judged: true, decision: "allow" });
    expect(() => manager.resolveReviewedPermission(pending, review)).toThrow("issued pipeline request");
    expect(manager.checkDetailed("web_fetch", "builtin", "network").decision).toBe("ask");
    await cache.flush();
  });

});
