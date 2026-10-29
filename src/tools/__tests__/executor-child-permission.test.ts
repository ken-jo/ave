import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { ApprovalGate, isHostApprovalRejectedDecision, IPC_APPROVAL_REQUEST, type ApprovalChoice, type ApprovalDecision, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { gateMutatingEffect } from "../../permissions/effect-enforcement.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../permissions/judge/judge-settings.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { captureApprovalWorkingDirectory, recordApproval, __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { ExecutionMode } from "../../shared/permission-mode.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import { createDynamicTool, type ToolCategory } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";

const CHILD_SESSION = "sub-child-permission";
const PARENT_SESSION = "conversation-parent";
let root: string;
let audit: AuditLogger;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-child-permission-"));
  vi.stubEnv("AVE_HOME", join(root, "state"));
  __resetSessionStoreForTest();
  audit = new AuditLogger(join(root, "audit"));
});
afterEach(async () => {
  await audit.close();
  __resetSessionStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

async function childInvocation(options: {
  mode?: ExecutionMode;
  category?: ToolCategory;
  headless?: boolean;
  choice?: ApprovalChoice;
  otherPrincipal?: boolean;
  storedGrant?: boolean;
  pausedParent?: boolean;
  changePolicy?: boolean;
  tamper?: "nonce" | "hmac";
  innerEffect?: boolean;
} = {}) {
  const otherPrincipal = options.otherPrincipal !== false;
  const sessionId = otherPrincipal ? CHILD_SESSION : PARENT_SESSION;
  const input = Object.freeze({ path: join(root, "notes.txt") });
  const execute = vi.fn(async () => {
    if (options.innerEffect) {
      await gateMutatingEffect({
        pluginId: "child-resource-owner", methodPath: "storage.write", effect: "write", target: "inner.txt",
        input: ["inner.txt", "nested mutation"], resolveStoragePath: (path) => join(root, path), permissionManager: manager, approvalGate: gate,
      });
      writeFileSync(join(root, "inner.txt"), "nested mutation");
    }
    return { output: "completed", isError: false };
  });
  const registry = new ToolRegistry();
  const tool = createDynamicTool({
    name: "child_resource", description: "Access a resource", source: "builtin", category: options.category ?? "write",
    pathFields: ["path"], jsonSchema: { type: "object", properties: { path: { type: "string" } } }, execute,
  });
  registry.register(tool);
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode(options.mode ?? "default");
  manager.setJudge({ settings: { ...DEFAULT_JUDGE_SETTINGS, chain: [] }, chain: [], breaker: manager.getJudgeBreaker(), audit },
    (id) => id === CHILD_SESSION ? PARENT_SESSION : id);
  if (options.storedGrant) {
    manager.setRules([{ pattern: tool.name, action: "allow" }]);
    await recordApproval(tool.name, canonicalStringify(input), "builtin", {
      scope: "session", sessionId, verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(root).identity,
    });
  }
  if (options.pausedParent) for (let index = 0; index < 3; index += 1) {
    manager.getJudgeBreaker().record(PARENT_SESSION, "deny", `parent-block-${index}`);
  }
  const breakerBefore = manager.getJudgeBreaker().snapshot(PARENT_SESSION);
  const review = vi.spyOn(manager, "dispatchReviewer");
  const memory = vi.spyOn(manager, "resolveRememberedPermission");
  const cards: ApprovalRequest[] = [];
  const resolutions: Array<ApprovalDecision | null> = [];
  const events: PermissionReviewEvent[] = [];
  const wc = makeMockWebContents();
  const gate = new ApprovalGate(wc as never);
  wc.send.mockImplementation((channel: string, card: ApprovalRequest) => {
    if (channel !== IPC_APPROVAL_REQUEST) return;
    cards.push(card);
    queueMicrotask(() => {
      if (options.changePolicy) manager.setRules([{ pattern: tool.name, action: "deny" }]);
      const answer: ApprovalDecision = {
        requestId: card.id, choice: options.innerEffect && cards.length > 1 ? "deny-once" : options.choice ?? "deny-once", nonce: card.nonce, hmac: card.hmac,
      };
      if (options.tamper) {
        resolutions.push(gate.resolveFromDesktopRenderer(card.id, { ...answer, [options.tamper]: "forged" }, wc as never));
        resolutions.push(gate.resolveFromDesktopRenderer(card.id, { ...answer, choice: "deny-once" }, wc as never));
      } else {
        resolutions.push(gate.resolveFromDesktopRenderer(card.id, answer, wc as never));
      }
    });
  });
  const request = vi.spyOn(gate, "requestAndWait");
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, audit);
  const [result] = await executor.executeAll([{ id: randomUUID(), name: tool.name, input }], {
    sessionId, executionCwd: root,
    permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: [root], otherPrincipal, headless: options.headless },
    callbacks: { onPermissionReview: (event) => events.push(event) },
  });
  return { result, execute, cards, request, resolutions, events, review, memory, manager, gate, wc, input, breakerBefore };
}

describe("child invocation permission authority", () => {
  it.each(["strict", "default", "auto", "allow"] as const)("requires a local once-only decision in %s", async (mode) => {
    const current = await childInvocation({ mode });
    expect(current.result.is_error).toBe(true);
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.review).not.toHaveBeenCalled();
    expect(current.memory).not.toHaveBeenCalled();
    expect(current.cards).toHaveLength(1);
    expect(current.request.mock.calls[0]?.[0]).toMatchObject({
      forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false, isReadOnly: false,
    });
    expect(current.request.mock.calls[0]?.[0]).not.toHaveProperty("parentAdjudicationEligible");
    expect(current.events.some((event) => event.status.startsWith("parent_"))).toBe(false);
  });

  it("keeps child reads on the same floor without a reviewer exception", async () => {
    const current = await childInvocation({ mode: "auto", category: "read" });
    expect(current.result.is_error).toBe(true);
    expect(current.cards).toHaveLength(1);
    expect(current.review).not.toHaveBeenCalled();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("denies headless child requests without asking or reviewing", async () => {
    const current = await childInvocation({ mode: "allow", headless: true });
    expect(current.result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(current.cards).toHaveLength(0);
    expect(current.request).not.toHaveBeenCalled();
    expect(current.review).not.toHaveBeenCalled();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("executes after one authenticated local allow-once answer", async () => {
    const current = await childInvocation({ choice: "allow-once" });
    expect(current.result.is_error).not.toBe(true);
    expect(current.execute).toHaveBeenCalledOnce();
    expect(current.cards).toHaveLength(1);
    expect(current.resolutions[0]).toMatchObject({ choice: "allow-once" });
    expect(current.review).not.toHaveBeenCalled();
  });

  it("rejects a local answer after policy changes while its card is pending", async () => {
    const current = await childInvocation({ choice: "allow-once", changePolicy: true });
    expect(current.result).toMatchObject({ is_error: true, content: expect.stringContaining("Permission policy changed") });
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.input).toEqual({ path: join(root, "notes.txt") });
  });

  it.each(["nonce", "hmac"] as const)("cannot use a forged %s to approve the child request", async (tamper) => {
    const current = await childInvocation({ choice: "allow-once", tamper });
    expect(current.resolutions[0]).toMatchObject({ choice: "deny-once", rememberPattern: "approval integrity check failed" });
    expect(isHostApprovalRejectedDecision(current.resolutions[0])).toBe(true);
    expect(current.resolutions[1]).toBeNull();
    expect(current.result.is_error).toBe(true);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("cannot replay the authenticated answer after the request has settled", async () => {
    const current = await childInvocation({ choice: "allow-once" });
    const card = current.cards[0];
    expect(current.gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
    }, current.wc as never)).toBeNull();
    expect(current.execute).toHaveBeenCalledOnce();
  });

  it("does not reset the parent turn's paused reviewer counters after a local approval", async () => {
    const current = await childInvocation({ choice: "allow-once", pausedParent: true });
    expect(current.result.is_error).not.toBe(true);
    expect(current.breakerBefore.open).toBe(true);
    expect(current.manager.getJudgeBreaker().snapshot(PARENT_SESSION)).toEqual(current.breakerBefore);
    expect(current.manager.isAutomatedApprovalPaused(CHILD_SESSION)).toBe(true);
  });

  it("keeps an approved enclosing child call from authorizing a nested effect", async () => {
    const current = await childInvocation({ mode: "auto", choice: "allow-once", innerEffect: true });
    expect(current.execute).toHaveBeenCalledOnce();
    expect(current.result.is_error).toBe(true);
    expect(current.cards).toHaveLength(2);
    expect(current.request.mock.calls[1]?.[0]).toMatchObject({
      kind: "agent-action", forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false,
    });
    expect(current.review).not.toHaveBeenCalled();
    expect(current.memory).not.toHaveBeenCalled();
    expect(existsSync(join(root, "inner.txt"))).toBe(false);
  });

  it("does not reuse rules or stored grants on behalf of another principal", async () => {
    const current = await childInvocation({ mode: "allow", storedGrant: true });
    expect(current.result.is_error).toBe(true);
    expect(current.memory).not.toHaveBeenCalled();
    expect(current.cards).toHaveLength(1);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("allows an ordinary same-principal read without creating a child card", async () => {
    const current = await childInvocation({ category: "read", otherPrincipal: false });
    expect(current.result.is_error).not.toBe(true);
    expect(current.execute).toHaveBeenCalledOnce();
    expect(current.cards).toHaveLength(0);
    expect(current.review).not.toHaveBeenCalled();
  });
});
