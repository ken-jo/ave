import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";
useConfigurationOwner();
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { judgeSettings, scriptedStage, collectingAudit } from "../judge/__tests__/judge-request-fixture.js";
import { dispatchPermissionReviewerCommandWithRewire } from "../permission-slash.js";
import { readPermissionSettings } from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
let root: string;
beforeEach(() => { root = resources.makeTmpDir("reviewer-reconfiguration-"); });
afterEach(async () => { await resources.cleanup(); });

function subject(customJudge = false) {
  let settingsError: string | undefined;
  const manager = new PermissionManager(join(root, "permissions.json"), undefined, () => settingsError);
  manager.setMode("auto");
  const classify = vi.fn(() => ({ level: "low" as const, reason: "Previously healthy reviewer" }));
  const judge = vi.fn(async () => ({ decision: "allow" as const, rationale: "Previously healthy custom judge" }));
  const cache = resources.makeVerdictCache(join(root, "cache.jsonl"));
  const lookup = vi.spyOn(cache, "lookup");
  const configure = () => {
    manager.setReviewer({ classifier: { classify }, cache, model: "fixture-reviewer" });
    const stage = scriptedStage("old-custom");
    manager.setJudge({ settings: judgeSettings({ chain: customJudge ? [stage] : [], categories: { shell: true, write: true, network: true } }),
      chain: customJudge ? [{ settings: stage, judge: { id: "old-custom", version: "fixture", judge } }] : [],
      breaker: manager.getJudgeBreaker(), audit: collectingAudit().logger });
  };
  configure();
  let invocation = 0;
  const check = (headless = false) => manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "reviewer-session", headless, rationaleAvailable: true });
  const review = async (headless = false) => {
    const permission = check(headless);
    const reviewed = await manager.dispatchReviewer("network_probe", { invocationId: `reviewer-request-${invocation++}`, sessionId: "reviewer-session", source: "builtin", category: "network", pathFields: [], finalInput: { url: "http://localhost:3456" }, executionCwd: root, allowedDirectories: [root], sensitivePathsAdjacent: [], trustOrigin: "llm-tool-arg", permissionDecision: permission, rationaleAvailable: true }, undefined, { lane: headless ? "headless" : "foreground-auto" });
    return { review: reviewed, permission: manager.resolveReviewedPermission(permission, reviewed) };
  };
  return { manager, classify, judge, lookup, configure, check, review, setSettingsError: (error?: string) => { settingsError = error; } };
}

describe("reviewer reconfiguration authority", () => {
  it.each([false, true])("keeps old cached/classifier/custom authority blocked after failed fault recovery, custom=%s", async custom => {
    const current = subject(custom);
    expect((await current.review()).permission.decision).toBe("allow");
    expect((await current.review()).permission.decision).toBe("allow");
    if (custom) expect(current.judge).toHaveBeenCalledTimes(2);
    else expect(current.classify).toHaveBeenCalledOnce();
    current.setSettingsError("Invalid stored reviewer mode");
    expect((await current.review()).permission.decision).toBe("ask");
    const oldPermission = current.check();
    const token = current.manager.beginReviewerReconfiguration();
    current.setSettingsError();
    current.classify.mockClear(); current.judge.mockClear(); current.lookup.mockClear();
    for (const headless of [false, true]) {
      const result = await current.review(headless);
      expect(result.review).toMatchObject({ outcome: "error", verdict: { level: "high" }, judge: { source: "fallback", fallback: "error" } });
      expect(result.review.verdict.reason).toContain("reconfiguration did not complete");
      expect(result.permission).toMatchObject({ decision: headless ? "deny" : "ask", reasonCode: headless ? "no-approver" : "reviewer-human-required" });
    }
    expect(current.manager.recheckPermission(oldPermission)).toMatchObject({ decision: "deny", reasonCode: "policy-changed" });
    expect(current.classify).not.toHaveBeenCalled(); expect(current.judge).not.toHaveBeenCalled(); expect(current.lookup).not.toHaveBeenCalled();
    current.configure();
    expect((await current.review()).permission.decision).toBe("ask");
    current.manager.completeReviewerReconfiguration(token);
    expect((await current.review()).permission.decision).toBe("allow");
  });

  it("does not let stale completion reopen a newer completed configuration", async () => {
    const current = subject(true);
    const older = current.manager.beginReviewerReconfiguration();
    const newer = current.manager.beginReviewerReconfiguration();
    current.configure();
    current.manager.completeReviewerReconfiguration(newer);
    expect((await current.review()).permission.decision).toBe("allow");
    current.configure();
    expect(() => current.manager.completeReviewerReconfiguration(older)).toThrow("current host token");
    expect((await current.review()).permission).toMatchObject({ decision: "ask", reasonCode: "reviewer-human-required" });
    expect(() => current.manager.completeReviewerReconfiguration({})).toThrow("current host token");
    expect((await current.review(true)).permission).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
  });

  it("lets a successful healthy-settings rollback restore review after the failed rewire", async () => {
    const current = subject(true);
    const path = join(root, "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { reviewer: { mode: "llm", fallbackOnError: "deny" } }, unrelated: true }));
    const failure = new Error("Provider factory failed before reviewer installation");
    const rewire = vi.fn(() => {
      const token = current.manager.beginReviewerReconfiguration();
      if (readPermissionSettings(path).permissions.reviewer.mode === "disabled") throw failure;
      current.configure();
      current.manager.completeReviewerReconfiguration(token);
    });
    const result = await dispatchPermissionReviewerCommandWithRewire({ verb: "mode", value: "disabled" }, rewire, path);
    expect(result).toEqual({ ok: false, error: `reviewer-rewire-failed: ${failure.message}` });
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(readPermissionSettings(path).permissions.reviewer.mode).toBe("llm");
    expect((await current.review()).permission.decision).toBe("allow");
  });
});
