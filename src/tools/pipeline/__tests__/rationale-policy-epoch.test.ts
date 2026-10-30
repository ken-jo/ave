import { setReviewerForTest } from "../../../__tests__/support/reviewer-judge.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookRunner } from "../../../hooks/hook-runner.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import {
  clearCategoryRegistry,
  getCategoryRegistryGeneration,
  registerStandardCategories,
} from "../../../permissions/category-registry.js";
import { caseFoldForMatch } from "../../../permissions/sensitive-paths.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import {
  __resetSessionStoreForTest,
  getUserApprovalGeneration,
  recordApproval,
} from "../../../permissions/user-approval-store.js";
import { captureRationalePolicyEpoch, captureRationalePolicySnapshot, issueRationaleApprovalPolicyTransition, matchesRationaleApprovedDirectoryTransition, validateRationaleApprovalPolicyTransition } from "../rationale-policy-epoch.js";

function epoch(input: {
  permissionManager?: PermissionManager;
  hookRunner?: HookRunner;
  scriptHookManager?: ScriptHookManager;
  additionalDirectories?: readonly string[];
} = {}): string {
  return captureRationalePolicyEpoch({
    permissionManager: input.permissionManager,
    hookRunner: input.hookRunner ?? new HookRunner(),
    scriptHookManager: input.scriptHookManager,
    additionalDirectories: input.additionalDirectories ?? [],
  });
}

afterEach(() => {
  __resetSessionStoreForTest();
  registerStandardCategories();
});

describe("rationale policy epoch", () => {
  it("tracks PermissionManager mode, reviewer and rule mutations but not stable setters", () => {
    const permissionManager = new PermissionManager("unused-permissions.json");
    const common = {
      permissionManager,
      hookRunner: new HookRunner(),
      scriptHookManager: new ScriptHookManager(),
    };
    let previous = epoch(common);
    const changes = (mutate: () => void) => {
      mutate();
      const next = epoch(common);
      expect(next).not.toBe(previous);
      previous = next;
    };

    changes(() => permissionManager.setMode("auto"));
    changes(() => setReviewerForTest(permissionManager, {
      classifier: { classify: vi.fn() } as never,
      cache: {} as never,
      recentlyDenied: {} as never,
    }));
    changes(() => permissionManager.setRules([
      { pattern: "bash", action: "deny" },
    ]));

    const stable = epoch(common);
    permissionManager.setMode("auto");

    expect(epoch(common)).toBe(stable);
  });

  it("tracks HookRunner and ScriptHookManager mutations", () => {
    const hookRunner = new HookRunner();
    const scriptHookManager = new ScriptHookManager();
    const common = { hookRunner, scriptHookManager };
    const initial = epoch(common);
    hookRunner.registerPreHook("rationale-pre", () => ({ action: "allow" }));
    const withPreHook = epoch(common);
    expect(withPreHook).not.toBe(initial);
    scriptHookManager.setTrustedRegistry([], []);
    expect(epoch(common)).not.toBe(withPreHook);
  });

  it("tracks Store B mutation and leaves an empty reset stable", async () => {
    __resetSessionStoreForTest();
    const empty = getUserApprovalGeneration();
    __resetSessionStoreForTest();
    expect(getUserApprovalGeneration()).toBe(empty);

    const before = epoch();
    await recordApproval("bash", '{"command":"pwd"}', "builtin", {
      scope: "session",
      sessionId: "11111111-1111-4111-8111-111111111111",
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
    });
    expect(epoch()).not.toBe(before);
  });

  it("tracks category membership and leaves an already-empty clear stable", () => {
    const before = epoch();
    clearCategoryRegistry();
    const after = epoch();
    expect(after).not.toBe(before);

    const empty = getCategoryRegistryGeneration();
    clearCategoryRegistry();
    expect(getCategoryRegistryGeneration()).toBe(empty);
    expect(epoch()).toBe(after);
  });

  it.each([
    ["Windows", "C:\\workspace", "D:\\shared"],
    ["macOS", "/Users/test/workspace", "/Volumes/shared"],
    ["Linux", "/home/test/workspace", "/mnt/shared"],
  ] as const)(
    "tracks additionalDirectories on %s without order or duplicate churn",
    (_platform, workspace, extra) => {
      const baseline = epoch({ additionalDirectories: [workspace] });
      const added = epoch({ additionalDirectories: [workspace, extra] });
      expect(added).not.toBe(baseline);
      expect(epoch({
        additionalDirectories: [extra, workspace, extra],
      })).toBe(added);
    },
  );

  it("keeps anchor and epoch wiring on one host-OS-independent path", () => {
    for (const relativePath of [
      "../../../ipc/handlers/chat.ts",
      "../../../engine/turn/run-turn.ts",
      "../../../engine/turn/trust-origin.ts",
      "../rationale-policy-epoch.ts",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/process\.platform/);
      expect(source).not.toMatch(
        /(?:case\s+|===\s*|!==\s*)["'](?:win32|darwin|linux)["']/,
      );
    }
  });
});

describe("same-card rationale policy changes", () => {
  const actionDigest = "a".repeat(64);
  const requestId = "approved-request";
  const decision = { requestId, choice: "allow-session" as const };

  function host() {
    const manager = new PermissionManager("unused-policy-transition.json");
    const hooks = new HookRunner();
    const directories: string[] = [];
    const capture = () => captureRationalePolicySnapshot({ permissionManager: manager, hookRunner: hooks, additionalDirectories: directories });
    return { manager, hooks, directories, capture };
  }

  it("binds an exact approved rule delta to the original card, action and final epoch", () => {
    const source = host();
    const before = source.capture();
    source.manager.setRules([{ pattern: "build", action: "allow" }]);
    const after = source.capture();
    const receipt = issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId,
      approvalGate: { consumeApprovalPolicyMutation: () => ({ permission: { from: before.permission, to: after.permission } }) } });
    expect(receipt).not.toBeNull();
    const expected = { decision, actionDigest, requestId, beforeEpoch: before.epoch, currentEpoch: after.epoch };
    expect(validateRationaleApprovalPolicyTransition(receipt, expected)).toBe(true);
    expect(validateRationaleApprovalPolicyTransition(receipt, { ...expected, decision: { ...decision } })).toBe(false);
    expect(validateRationaleApprovalPolicyTransition(receipt, { ...expected, actionDigest: "b".repeat(64) })).toBe(false);
    source.manager.setMode("allow");
    expect(validateRationaleApprovalPolicyTransition(receipt, { ...expected, currentEpoch: source.capture().epoch })).toBe(false);
    expect(validateRationaleApprovalPolicyTransition({ kind: "approved-policy-transition" }, expected)).toBe(false);
  });

  it("refuses a simultaneous hook mutation even when the card's rule grant is authentic", () => {
    const source = host();
    const before = source.capture();
    source.manager.setRules([{ pattern: "build", action: "allow" }]);
    source.hooks.registerPreHook("changed-hook", () => ({ action: "allow" }));
    const after = source.capture();
    expect(issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId,
      approvalGate: { consumeApprovalPolicyMutation: () => ({ permission: { from: before.permission, to: after.permission } }) } })).toBeNull();
  });

  it("refuses concurrent approval changes beyond the exact recorded memory grant", async () => {
    const source = host();
    const before = source.capture();
    await recordApproval("build", "{}", "builtin", { scope: "session", sessionId: "approved-session", verdictAtApproval: "low", nlJustification: null });
    const granted = source.capture();
    await recordApproval("unrelated", "{}", "builtin", { scope: "session", sessionId: "approved-session", verdictAtApproval: "low", nlJustification: null });
    const after = source.capture();
    expect(issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId,
      approvalGate: { consumeApprovalPolicyMutation: () => ({ approvals: { from: before.approvals, to: granted.approvals, scope: "session" } }) } })).toBeNull();
  });

  it("accepts only the chosen folder addition and rejects another folder arriving with it", () => {
    const source = host();
    const before = source.capture();
    source.directories.push("/workspace/selected");
    const after = source.capture();
    const approvalGate = { consumeApprovalPolicyMutation: () => ({ directories: { from: before.additionalDirectories, to: after.additionalDirectories, directory: "/workspace/selected", scope: "session" } }) };
    expect(issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId, approvalGate })).not.toBeNull();
    source.directories.push("/workspace/unrelated");
    expect(issueRationaleApprovalPolicyTransition({ before, after: source.capture(), decision, actionDigest, requestId, approvalGate })).toBeNull();
  });

  it("rejects reconstructed snapshots and missing native mutation evidence", () => {
    const source = host();
    const before = source.capture();
    source.manager.setMode("allow");
    const after = source.capture();
    expect(issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId, approvalGate: {} })).toBeNull();
    expect(issueRationaleApprovalPolicyTransition({ before: { ...before }, after, decision, actionDigest, requestId,
      approvalGate: { consumeApprovalPolicyMutation: () => ({ permission: { from: before.permission, to: after.permission } }) } })).toBeNull();
  });
});

it("accepts an exact actual approval-store grant with no unrelated policy mutation", async () => {
  const hooks = new HookRunner();
  const source = { hookRunner: hooks, additionalDirectories: [] };
  const before = captureRationalePolicySnapshot(source);
  await recordApproval("approved_call", "{}", "builtin", { scope: "session", sessionId: "approved-session", verdictAtApproval: "low", nlJustification: null });
  const after = captureRationalePolicySnapshot(source);
  const decision = { requestId: "approved-memory", choice: "allow-session" as const };
  const actionDigest = "d".repeat(64);
  const receipt = issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId: decision.requestId,
    approvalGate: { consumeApprovalPolicyMutation: () => ({ approvals: { from: before.approvals, to: after.approvals, scope: "session" } }) } });
  expect(receipt).not.toBeNull();
  expect(validateRationaleApprovalPolicyTransition(receipt, { decision, actionDigest, requestId: decision.requestId, beforeEpoch: before.epoch, currentEpoch: after.epoch })).toBe(true);
});

it("changes an execution scope only by the approved folder and its provisional descendants", () => {
  const hooks = new HookRunner();
  const before = captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [] });
  const folder = "/outside/selected";
  const after = captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [folder] });
  const decision = { requestId: "selected-folder", choice: "allow-session" as const };
  const receipt = issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest: "f".repeat(64), requestId: decision.requestId,
    approvalGate: { consumeApprovalPolicyMutation: () => ({ directories: { from: [], to: [folder], directory: folder, scope: "session" } }) } });
  expect(receipt).not.toBeNull();
  const beforeDirectories = ["/project", `${folder}/target.txt`, "/unrelated/base"];
  expect(matchesRationaleApprovedDirectoryTransition(receipt, { beforeDirectories, currentDirectories: ["/project", folder, "/unrelated/base"] })).toBe(true);
  expect(matchesRationaleApprovedDirectoryTransition(receipt, { beforeDirectories, currentDirectories: [...beforeDirectories, folder] })).toBe(true);
  expect(matchesRationaleApprovedDirectoryTransition(receipt, { beforeDirectories, currentDirectories: ["/project", folder] })).toBe(false);
  expect(matchesRationaleApprovedDirectoryTransition(receipt, { beforeDirectories, currentDirectories: ["/project", folder, "/unrelated/base", "/another/folder"] })).toBe(false);
  expect(matchesRationaleApprovedDirectoryTransition(receipt, { beforeDirectories: ["/project", "/outside/selected-sibling/target.txt"], currentDirectories: ["/project", folder] })).toBe(false);
  expect(matchesRationaleApprovedDirectoryTransition({ kind: "approved-policy-transition" }, { beforeDirectories, currentDirectories: ["/project", folder, "/unrelated/base"] })).toBe(false);
});

it("retains the stored folder spelling in policy proof and matches provisional execution scope by host identity", () => {
  const hooks = new HookRunner();
  const physicalFolder = "/outside/PreservedFolder";
  const chosenFolder = caseFoldForMatch(physicalFolder);
  const before = captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [] });
  const after = captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [physicalFolder] });
  const decision = { requestId: "preserved-folder", choice: "allow-always" as const };
  const actionDigest = "e".repeat(64);
  const receipt = issueRationaleApprovalPolicyTransition({ before, after, decision, actionDigest, requestId: decision.requestId,
    approvalGate: { consumeApprovalPolicyMutation: () => ({ directories: { from: [], to: [physicalFolder], directory: physicalFolder, scope: "always" } }) } });
  expect(receipt).not.toBeNull();
  expect(after.additionalDirectories).toEqual([physicalFolder]);
  expect(matchesRationaleApprovedDirectoryTransition(receipt, { beforeDirectories: ["/project", `${chosenFolder}/target.txt`], currentDirectories: ["/project", physicalFolder] })).toBe(true);
  const foldedSnapshot = captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [chosenFolder] });
  expect(validateRationaleApprovalPolicyTransition(receipt, { decision, actionDigest, requestId: decision.requestId, beforeEpoch: before.epoch, currentEpoch: foldedSnapshot.epoch })).toBe(foldedSnapshot.epoch === after.epoch);
  const otherCaseFolder = physicalFolder.toLowerCase();
  const differentCaseSnapshot = captureRationalePolicySnapshot({ hookRunner: hooks, additionalDirectories: [otherCaseFolder] });
  const otherCaseReceipt = issueRationaleApprovalPolicyTransition({ before, after: differentCaseSnapshot, decision, actionDigest, requestId: decision.requestId,
    approvalGate: { consumeApprovalPolicyMutation: () => ({ directories: { from: [], to: [otherCaseFolder], directory: physicalFolder, scope: "always" } }) } });
  expect(otherCaseReceipt).toBeNull();
});
