import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionTestResources } from "./test-resources.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";

const resources = new PermissionTestResources();
const DESTINATION = { host: "api.example.com", port: 443, source: "builtin", network: "public", ruleScopes: ["user"] } as const;
let directory: string;
let manager: PermissionManager;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "network-permission-"));
  manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("default");
});
afterEach(async () => { await resources.cleanup(); await cleanupTmpDir(directory); });

describe("actual network connection pipeline", () => {
  it("applies an exact network deny before floors and remembered registry consent", async () => {
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "deny" }]);
    const result = await manager.checkNetworkPermission(DESTINATION, { floor: { code: "other-principal", reason: "External influence" } });
    expect(result.permission).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant").decision).toBe("deny");
  });

  it.each(["strict", "default", "auto", "allow"] as const)("retains earlier network grants before an exfiltration guardrail in %s", async mode => {
    manager.setMode(mode);
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "allow" }]);
    const context = { exfiltration: { reason: "Credential upload" } };
    const result = await manager.checkNetworkPermission(DESTINATION, context);
    expect(result.permission).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(result.permission.forceModal).toBeUndefined();
    expect(result.permission.reviewer).toBeUndefined();
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant")).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect((await manager.checkNetworkPermission(DESTINATION, { ...context, headless: true })).permission)
      .toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    manager.setRules([]);
    const pending = await manager.checkNetworkPermission(DESTINATION, context);
    expect(pending.permission.decision).toBe(mode === "allow" ? "allow" : "ask");
    expect(pending.permission.forceModal).toBeUndefined();
    expect(pending.permission.reviewer?.route).toBe(mode === "auto" ? "foreground-auto" : undefined);
    expect((await manager.checkNetworkPermission(DESTINATION, { ...context, headless: true })).permission)
      .toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
  });

  it("keeps an explicit network ask before remembered registry consent", async () => {
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "ask" }]);
    const result = await manager.checkNetworkPermission(DESTINATION);
    expect(result.rule?.decision).toBe("ask");
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant")).toMatchObject({ decision: "ask", reasonCode: "rule-ask" });
  });

  it.each([
    { network: "public", ruleScopes: ["user"], decision: "allow" },
    { network: "public", ruleScopes: [], decision: "ask" },
    { network: "local", ruleScopes: ["user"], decision: "ask" },
    { network: "unverified", ruleScopes: ["user"], decision: "ask" },
  ] as const)("uses eligible rule scope for $network destinations", async ({ network, ruleScopes, decision }) => {
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "allow" }]);
    const result = await manager.checkNetworkPermission({ ...DESTINATION, network, ruleScopes });
    expect(result.permission.decision).toBe(decision);
    expect(result.rule?.decision).toBe(decision === "allow" ? "allow" : undefined);
  });

  it("keeps conversation network rules within their actual consent scope", async () => {
    manager.addSessionRule("network-session", "Network(api.example.com:443)");
    const rejectedScope = await manager.checkNetworkPermission(DESTINATION, { sessionId: "network-session" });
    expect(rejectedScope.permission.decision).toBe("ask");
    const allowed = await manager.checkNetworkPermission({ ...DESTINATION, ruleScopes: ["session"] }, { sessionId: "network-session" });
    expect(allowed).toMatchObject({ permission: { decision: "allow" }, rule: { scope: "session" } });
    expect((await manager.checkNetworkPermission({ ...DESTINATION, ruleScopes: ["session"] }, { sessionId: "other-session" })).permission.decision).toBe("ask");
  });

  it("does not inherit enclosing shell or fetch rules and identities", async () => {
    manager.setRules([{ pattern: "Bash(curl *)", action: "allow" }, { pattern: "bash", action: "allow" }, { pattern: "WebFetch(domain:api.example.com)", action: "allow" }]);
    const result = await manager.checkNetworkPermission(DESTINATION, {
      ruleSubject: { kind: "shell", dialect: "bash", command: "curl https://api.example.com", cwd: directory },
      approvalCacheKey: "outer-shell-grant",
    });
    expect(result.permission).toMatchObject({ decision: "ask", pipelineRequest: { tool: { name: "sandbox_network", kind: "network" } } });
    expect(result.reasonKey).toBe(result.permission.reasonCode);
    expect(JSON.parse(result.identity)).toEqual({ kind: "network", host: "api.example.com", port: 443, source: "builtin" });
    const canonical = await manager.checkNetworkPermission({ ...DESTINATION, host: "API.EXAMPLE.COM." });
    expect(canonical.identity).toBe(result.identity);
    expect((await manager.checkNetworkPermission({ ...DESTINATION, port: 8443 })).identity).not.toBe(result.identity);
  });

  it("requires fresh manual approval before remembered network consent", async () => {
    manager.setMode("allow");
    manager.setRules([{ pattern: "Network(api.example.com:443)", action: "allow" }]);
    const result = await manager.checkNetworkPermission(DESTINATION, { manualRerun: true });
    expect(manager.resolveRememberedPermission(result.permission, "Registry grant")).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "manual-rerun" });
  });

  it("denies policy corruption and invalid endpoints before grants", async () => {
    manager.setMode("allow");
    const corrupt = await manager.checkNetworkPermission(DESTINATION, { permissionStoreError: "Policy cannot be read" });
    expect(corrupt.permission).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
    const invalid = await manager.checkNetworkPermission({ ...DESTINATION, port: 0 });
    expect(invalid.permission).toMatchObject({ decision: "deny", reasonCode: "invalid-network-destination" });
  });

  it.each(["low", "high"] as const)("reviews a headless network effect before its %s fallback", async (level) => {
    manager.setMode("auto");
    setReviewerForTest(manager, { classifier: { classify: () => ({ level, reason: "Actual destination reviewed" }) }, cache: resources.makeVerdictCache(join(directory, "network-review.jsonl")) });
    const result = await manager.checkNetworkPermission(DESTINATION, { headless: true });
    expect(result.permission.reviewer?.route).toBe("headless");
    const review = await manager.dispatchReviewer("sandbox_network", {
      invocationId: "network-effect", sessionId: "network-session", source: "builtin", category: "network",
      pathFields: [], finalInput: result.destination, executionCwd: directory, allowedDirectories: [directory],
      sensitivePathsAdjacent: [], trustOrigin: "user-keyboard", permissionDecision: result.permission,
    }, undefined, { lane: "headless" });
    const decision = manager.resolveReviewedPermission(result.permission, review);
    expect(decision.decision).toBe(level === "low" ? "allow" : "deny");
    if (level === "high") expect(decision.reason).toBe(NO_APPROVER_MESSAGE);
  });
});
