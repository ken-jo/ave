import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorkBoardProjectScope } from "../../ipc/work-board-project-scope.js";
import { getDefaultWorkspaceRoot } from "../../main/default-workspace-root.js";
import type { MainWindow } from "../../main/main-window-host.js";
import { ApprovalSurfaceRegistry, updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { ApprovalGate, isHostApprovalRejectedDecision, isHostApprovalTimeoutDecision, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { approvalSurfaceResolver } from "../approval-surface.js";
import { makeTestPolicy } from "../../permissions/__tests__/test-helpers.js";
import { createExtensionStartAsker } from "../../permissions/extension-start-asker.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";

function surfaceFixture() {
  const state = { destroyed: false };
  const contents = { isDestroyed: () => state.destroyed, send: vi.fn(), on: vi.fn(), mainFrame: {} } as unknown as WebContents;
  return { state, contents };
}

function gateFixture(registry: ApprovalSurfaceRegistry) {
  return new ApprovalGate(approvalSurfaceResolver(registry), makeTestPolicy(), 5 * 60 * 1000);
}

const request = (id: string) => ({
  id, sessionId: "board-root", category: "tool" as const, toolName: "write_probe",
  toolCategory: "write" as const, source: "builtin" as const, args: {},
  reason: "write requires approval", createdAt: Date.now(),
});

afterEach(() => vi.useRealTimers());

describe("registered approval surface resolution", () => {
  it("reads only registrations for arbitrary run identities and ignores unrelated owners", () => {
    const registry = new ApprovalSurfaceRegistry();
    const first = surfaceFixture();
    const second = surfaceFixture();
    registry.registerUnattributed(second.contents);
    const resolve = approvalSurfaceResolver(registry);
    expect(resolve("board-root")).toBeNull();
    registry.register("board-root", first.contents);
    expect(resolve("board-root")).toBe(first.contents);
    expect(resolve(undefined)).toBe(second.contents);
    registry.register("board-root", second.contents);
    expect(resolve("board-root")).toBe(second.contents);
    second.state.destroyed = true;
    expect(resolve("board-root")).toBeNull();
  });

  it("denies an unregistered run explicitly instead of issuing an undeliverable card", async () => {
    const registry = new ApprovalSurfaceRegistry();
    registry.registerUnattributed(surfaceFixture().contents);
    const gate = gateFixture(registry);
    const decision = await gate.requestAndWait(request("no-owner"));
    expect(decision).toMatchObject({ choice: "deny-once", rememberPattern: "Nobody can approve this request; do not retry." });
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    expect(gate.pendingCount).toBe(0);
  });

  it("authorizes only the newly registered owner after transfer, including an existing child", async () => {
    const registry = new ApprovalSurfaceRegistry();
    const first = surfaceFixture();
    const second = surfaceFixture();
    registry.register("board-root", first.contents);
    registry.inherit("child", "board-root");
    const gate = gateFixture(registry);
    const pending = gate.requestAndWait({ ...request("transfer"), sessionId: "child" });
    await vi.waitFor(() => expect(gate.pendingCount).toBe(1));
    registry.register("board-root", second.contents);
    expect(gate.listPendingRendererRequests(first.contents)).toEqual([]);
    const [card] = gate.listPendingRendererRequests(second.contents);
    const response = { requestId: card.id, choice: "allow-once" as const, nonce: card.nonce, hmac: card.hmac };
    gate.resolveFromDesktopRenderer(card.id, response, first.contents);
    expect(gate.pendingCount).toBe(1);
    gate.resolveFromDesktopRenderer(card.id, response, second.contents);
    expect(await pending).toMatchObject({ choice: "allow-once" });
  });

  it("names the missing surface when the registered owner disappears just before delivery", async () => {
    const registry = new ApprovalSurfaceRegistry();
    const owner = surfaceFixture();
    registry.register("board-root", owner.contents);
    const gate = new ApprovalGate(approvalSurfaceResolver(registry), makeTestPolicy(), undefined, {
      fire: () => registry.releaseOwner(owner.contents),
    } as never);
    const decision = await gate.requestAndWait(request("owner-lost-before-send"));
    expect(decision).toMatchObject({ choice: "deny-once", rememberPattern: "Nobody can approve this request; do not retry." });
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(owner.contents.send).not.toHaveBeenCalled();
  });

  it("delivers a pending project card with the originally registered root", async () => {
    vi.useFakeTimers();
    const owner = surfaceFixture();
    const window = { webContents: owner.contents, isDestroyed: () => owner.state.destroyed } as MainWindow;
    const gate = new ApprovalGate(approvalSurfaceResolver(undefined, () => [window]), makeTestPolicy());
    const sessionId = "pending-project-snapshot";
    const projectRoot = getDefaultWorkspaceRoot();
    const project = { itemId: 1, projectRoot };
    updateApprovalSurface({ kind: "attach-project", sessionId, project });
    try {
      const pending = gate.requestAndWait({ ...request("parked-project"), sessionId });
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.pendingCount).toBe(1);
      expect(owner.contents.send).not.toHaveBeenCalled();

      project.projectRoot = `${projectRoot}/another-project`;
      expect(setWorkBoardProjectScope(owner.contents, projectRoot)).toBe(true);
      gate.reconcileWorkBoardProjectApprovals();

      const [card] = gate.listPendingRendererRequests(owner.contents);
      expect(card?.workBoardProjectApproval).toEqual({ itemId: 1, projectRoot, parked: true });
      expect(owner.contents.send).toHaveBeenCalledWith("ave:approval:request", card);
      gate.resolveFromDesktopRenderer(card.id, {
        requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
      }, owner.contents);
      await expect(pending).resolves.toMatchObject({ choice: "allow-once" });
    } finally {
      gate.disposeAll();
      updateApprovalSurface({ kind: "release", sessionId });
    }
  });

  it("denies a parked project card when its presentation reaches an unattended stage", async () => {
    vi.useFakeTimers();
    const owner = surfaceFixture();
    const window = { webContents: owner.contents, isDestroyed: () => owner.state.destroyed } as MainWindow;
    const gate = new ApprovalGate(approvalSurfaceResolver(undefined, () => [window]), makeTestPolicy());
    const sessionId = "pending-project-unattended-presentation";
    const projectRoot = getDefaultWorkspaceRoot();
    updateApprovalSurface({ kind: "attach-project", sessionId, project: { itemId: 1, projectRoot } });
    try {
      const pending = gate.requestAndWait({ ...request("parked-project-unattended"), sessionId });
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.pendingCount).toBe(1);
      expect(setWorkBoardProjectScope(owner.contents, projectRoot)).toBe(true);
      turnExtensionPolicyContext.run({ unattendedStage: true, allowExternalHooks: false }, () => {
        gate.reconcileWorkBoardProjectApprovals();
      });

      expect(owner.contents.send).not.toHaveBeenCalled();
      expect(gate.listPendingRendererRequests(owner.contents)).toEqual([]);
      expect(gate.pendingCount).toBe(0);
      await expect(pending).resolves.toMatchObject({ choice: "deny-once", reasonCode: "unattended-approval-denied" });
    } finally {
      gate.disposeAll();
      updateApprovalSurface({ kind: "release", sessionId });
    }
  });

  it("reports an extension start card nobody answered as unanswered, never as a person's no", async () => {
    vi.useFakeTimers();
    const registry = new ApprovalSurfaceRegistry();
    registry.register("board-root", surfaceFixture().contents);
    const asker = createExtensionStartAsker({ approvalGate: gateFixture(registry), reason: () => "start it?", notify: vi.fn() });
    const answer = asker.ask([{ key: "mcp-stdio:files", identity: "fixture", kind: "mcp-stdio", label: "files", cause: "no-backend" }], { sessionId: "board-root" });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(answer).resolves.toBe("expired");
  });

  it("keeps an ownerless parked card pending until the normal five-minute deny timeout", async () => {
    vi.useFakeTimers();
    const registry = new ApprovalSurfaceRegistry();
    const owner = surfaceFixture();
    const foreign = surfaceFixture();
    registry.register("board-root", owner.contents);
    const gate = gateFixture(registry);
    const pending = gate.requestAndWait(request("close-without-abort"));
    await vi.advanceTimersByTimeAsync(0);
    const [card] = gate.listPendingRendererRequests(owner.contents);
    expect(card).toBeDefined();
    registry.releaseOwner(owner.contents);
    owner.state.destroyed = true;
    expect(gate.listPendingRendererRequests(foreign.contents)).toEqual([]);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
    }, foreign.contents);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(gate.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const decision = await pending;
    expect(decision.choice).toBe("deny-once");
    expect(isHostApprovalTimeoutDecision(decision)).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(owner.contents.send).toHaveBeenCalledWith("ave:approval:request", expect.objectContaining({ id: card.id } satisfies Partial<ApprovalRequest>));
  });
});
