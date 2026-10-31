import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPermissionManager } from "../../boot/conversation.js";
import { SettingsService } from "../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { allowOnceCardAnswer } from "../../__tests__/support/approval-card-answer.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../approval-gate.js";
import { permissionSettingsPath, readPermissionSettings } from "../permission-settings-store.js";

let directory: string;
let project: string;
let policyPath: string;
const caches: VerdictCache[] = [];
const gates: ApprovalGate[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-policy-admission-"));
  project = join(directory, "project");
  const home = join(directory, "home");
  mkdirSync(project);
  mkdirSync(home, { mode: 0o700 });
  vi.stubEnv("AVE_HOME", home);
  policyPath = permissionSettingsPath();
  writeFileSync(policyPath, JSON.stringify({ permissions: { additionalDirectories: [] } }));
});

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.disposeAll();
  for (const cache of caches.splice(0)) await cache.flush();
  vi.unstubAllEnvs();
  await cleanupTmpDir(directory);
});

function probe(category: "read" | "write" = "read") {
  const execute = vi.fn(async () => ({ output: "executed", isError: false }));
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: "policy_probe", description: "Permission configuration admission probe", source: "builtin", category,
    jsonSchema: { type: "object", properties: {} }, isReadOnly: () => category === "read", execute }));
  return { registry, execute };
}

const options = () => ({ sessionId: "policy-admission-session", executionCwd: project, permissionContext: userPermissionContext() });

describe("production permission configuration admission", () => {
  it.each(["strict", "default", "auto", "allow"] as const)("denies actual reads, network rules and remembered grants before review in %s", async mode => {
    const manager = await createPermissionManager();
    manager.setMode(mode);
    manager.setRules([{ pattern: "policy_probe", action: "allow" }, { pattern: "Network(example.test:443)", action: "allow" }]);
    const classify = vi.fn(() => ({ level: "low" as const, reason: "Must not override corrupt policy" }));
    const cache = new VerdictCache(join(directory, "cache.jsonl"));
    caches.push(cache);
    setReviewerForTest(manager, { classifier: { classify }, cache });
    writeFileSync(policyPath, "{invalid policy");
    expect(readPermissionSettings().fault?.kind).toBe("file-unreadable");
    const current = probe();
    const executor = new ToolExecutor(current.registry, undefined, manager);
    const results = await executor.executeAll([{ id: "read", name: "policy_probe", input: {} }], options());
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("Permission settings are unreadable");
    expect(current.execute).not.toHaveBeenCalled();
    const denied = manager.checkDetailed("policy_probe", "builtin", "read");
    expect(manager.resolveRememberedPermission(denied, "Previous explicit grant")).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
    const network = await manager.checkNetworkPermission({ host: "example.test", port: 443, source: "builtin", network: "public", ruleScopes: ["user"] }, { headless: true });
    expect(network.permission).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("invalidates issued authority on a live policy fault and permits fresh calls after actual policy repair", async () => {
    const manager = await createPermissionManager();
    manager.setMode("allow");
    const initial = manager.checkDetailed("policy_probe", "builtin", "read");
    const epoch = manager.getPolicyEpoch();
    writeFileSync(policyPath, JSON.stringify({ permissions: null }));
    expect(manager.getPolicyEpoch()).not.toBe(epoch);
    expect(manager.recheckPermission(initial)).toMatchObject({ decision: "deny", reasonCode: "policy-changed" });
    const faultEpoch = manager.getPolicyEpoch();
    expect(manager.checkDetailed("policy_probe", "builtin", "read")).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
    writeFileSync(policyPath, JSON.stringify({ permissions: { additionalDirectories: [] } }));
    expect(manager.getPolicyEpoch()).not.toBe(faultEpoch);
    expect(manager.checkDetailed("policy_probe", "builtin", "read").decision).toBe("allow");
    expect(manager.getPolicyEpoch().split(":")).toHaveLength(3);
  });

  it("an ordinary application preference save cannot erase the separate permission policy fault", async () => {
    const manager = await createPermissionManager();
    manager.setMode("allow");
    writeFileSync(policyPath, "{invalid permission policy");
    const service = new SettingsService({ userDataPath: join(directory, "app-data"), encryption: unavailableSecretEncryption });
    await service.patch({ system: { ...service.get("system"), hardwareAcceleration: false } });
    expect(manager.checkDetailed("policy_probe", "builtin", "read")).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
  });

  it("denies corruption after authentic human approval and tool start before the handler", async () => {
    const manager = await createPermissionManager();
    manager.setMode("default");
    const current = probe("write");
    const issuedCards: ApprovalRequest[] = [];
    const contents = { isDestroyed: () => false, send: (channel: string, card: ApprovalRequest) => {
      if (channel === IPC_APPROVAL_REQUEST) {
        issuedCards.push(card);
        queueMicrotask(() => gate.resolveFromDesktopRenderer(card.id, allowOnceCardAnswer(card), contents as never));
      }
    } };
    const gate = new ApprovalGate(contents as never);
    gates.push(gate);
    const executor = new ToolExecutor(current.registry, undefined, manager, undefined, gate);
    const onToolStart = vi.fn(() => writeFileSync(policyPath, "{policy changed after approval"));
    const result = await executor.executeAll([{ id: "human-approved", name: "policy_probe", input: {} }], { ...options(), callbacks: { onToolStart } });
    expect(issuedCards).toHaveLength(1);
    expect(onToolStart).toHaveBeenCalledOnce();
    expect(result[0].is_error).toBe(true);
    expect(result[0].content).toContain("Permission policy changed");
    expect(current.execute).not.toHaveBeenCalled();
  });
});

it.each(["strict", "rule", "unrecognized"])("keeps readable policy active while a live %s reviewer setting fails closed at review", async mode => {
  const manager = await createPermissionManager();
  manager.setMode("auto");
  const classify = vi.fn(() => ({ level: "low" as const, reason: "Previous valid reviewer" }));
  const cache = new VerdictCache(join(directory, "mode-fault-cache.jsonl"));
  caches.push(cache);
  setReviewerForTest(manager, { classifier: { classify }, cache });
  const previous = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "reviewer-settings-session" });
  writeFileSync(policyPath, JSON.stringify({ permissions: { additionalDirectories: [project], reviewer: { mode } } }));
  expect(readPermissionSettings().fault?.kind).toBe("reviewer-mode-invalid");
  expect(readPermissionSettings().permissions.additionalDirectories).toEqual([project]);
  expect(manager.checkDetailed("ordinary_read", "builtin", "read")).toMatchObject({ decision: "allow", reasonCode: "ordinary-read" });
  expect(manager.recheckPermission(previous)).toMatchObject({ decision: "deny", reasonCode: "policy-changed" });
  for (const headless of [false, true]) {
    const initial = manager.checkDetailed("network_probe", "builtin", "network", undefined, { sessionId: "reviewer-settings-session", headless, rationaleAvailable: true });
    const review = await manager.dispatchReviewer("network_probe", { invocationId: `live-invalid-mode-${headless}`, sessionId: "reviewer-settings-session", source: "builtin", category: "network", pathFields: [], finalInput: {}, executionCwd: project, allowedDirectories: [project], sensitivePathsAdjacent: [], trustOrigin: "llm-tool-arg", permissionDecision: initial, rationaleAvailable: true });
    expect(review).toMatchObject({ outcome: "error", verdict: { level: "high" }, judge: { source: "fallback", fallback: "error" } });
    expect(manager.resolveReviewedPermission(initial, review)).toMatchObject({ decision: headless ? "deny" : "ask", reasonCode: headless ? "no-approver" : "reviewer-human-required" });
  }
  expect(classify).not.toHaveBeenCalled();
});
