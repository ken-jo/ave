import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalSurfaceResolver } from "../../boot/approval-surface.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, IPC_APPROVAL_SETTLED, isHostApprovalRejectedDecision, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { markMainWindowFocused, registerMainWindow, resetMainWindowsForTests, unregisterMainWindow } from "../app-state.js";

vi.mock("../terminal/pty-manager.js", () => ({ terminalOwnerWindowId: () => null }));

function mainWindow(id: number) {
  const state = { destroyed: false };
  const contents = Object.assign(new EventEmitter(), {
    id, isDestroyed: () => state.destroyed, send: vi.fn(),
  });
  const window = { id, webContents: contents, isDestroyed: () => state.destroyed } as unknown as BrowserWindow;
  const cards = () => contents.send.mock.calls.filter(([channel]) => channel === IPC_APPROVAL_REQUEST).map(([, request]) => request as ApprovalRequest);
  const settled = () => contents.send.mock.calls.filter(([channel]) => channel === IPC_APPROVAL_SETTLED).map(([, payload]) => payload.requestId as string);
  return { window, contents: contents as unknown as WebContents, state, cards, settled, listenerCount: () => contents.listenerCount("destroyed") };
}

const gates: ApprovalGate[] = [];
beforeEach(() => resetMainWindowsForTests());
afterEach(() => { for (const gate of gates.splice(0)) gate.disposeAll(); resetMainWindowsForTests(); });

function fixture() {
  const first = mainWindow(101);
  const second = mainWindow(102);
  registerMainWindow(first.window, "primary");
  registerMainWindow(second.window, "secondary");
  markMainWindowFocused(first.window);
  const gate = new ApprovalGate(approvalSurfaceResolver());
  gates.push(gate);
  const pending = gate.requestAndWait({ id: "panel-request", category: "tool", toolName: "panel_status", toolCategory: "write",
    source: "plugin", sourcePluginId: "sample-panel", args: {}, reason: "Panel request", createdAt: Date.now() });
  const answer = (owner: WebContents) => {
    const card = first.cards()[0];
    return gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, owner);
  };
  return { first, second, gate, pending, answer };
}

describe("main-window lifecycle for unattributed approvals", () => {
  it("keeps the receiving window authorized after focus changes and rejects other senders", async () => {
    const h = fixture();
    markMainWindowFocused(h.second.window);
    expect(h.second.cards()).toHaveLength(0);
    expect(h.gate.listPendingRendererRequests(h.second.contents)).toEqual([]);
    expect(h.gate.listPendingRendererRequests(h.first.contents)).toHaveLength(1);
    expect(h.answer(h.second.contents)).toBeNull();
    expect(h.answer(mainWindow(103).contents)).toBeNull();
    expect(h.gate.pendingCount).toBe(1);
    expect(h.answer(h.first.contents)?.choice).toBe("allow-once");
    expect(await h.pending).toMatchObject({ choice: "allow-once" });
    expect(h.first.listenerCount()).toBe(0);
  });

  it("re-sends to the next main window on unregister without requiring a pending-list refresh", async () => {
    const h = fixture();
    markMainWindowFocused(h.second.window);
    unregisterMainWindow(h.first.window);
    expect(h.first.settled()).toEqual(["panel-request"]);
    expect(h.second.cards()).toEqual(h.first.cards());
    expect(h.answer(h.first.contents)).toBeNull();
    expect(h.answer(h.second.contents)?.choice).toBe("allow-once");
    expect(await h.pending).toMatchObject({ choice: "allow-once" });
    expect(h.second.settled()).toEqual(["panel-request"]);
    expect(h.first.listenerCount()).toBe(0);
    expect(h.second.listenerCount()).toBe(0);
  });

  it("hands off once when destruction is followed by window unregistration", async () => {
    const h = fixture();
    markMainWindowFocused(h.second.window);
    h.first.state.destroyed = true;
    h.first.contents.emit("destroyed");
    unregisterMainWindow(h.first.window);
    await Promise.resolve();
    expect(h.second.cards()).toHaveLength(1);
    expect(h.answer(h.second.contents)?.choice).toBe("allow-once");
    await h.pending;
  });

  it("hands off a destroyed recipient even before an explicit unregister callback", async () => {
    const h = fixture();
    markMainWindowFocused(h.second.window);
    h.first.state.destroyed = true;
    h.first.contents.emit("destroyed");
    await Promise.resolve();
    expect(h.second.cards()).toHaveLength(1);
    expect(h.answer(h.second.contents)?.choice).toBe("allow-once");
    await h.pending;
  });

  it("denies immediately with no-approver feedback when all main windows close", async () => {
    const h = fixture();
    unregisterMainWindow(h.first.window);
    unregisterMainWindow(h.second.window);
    const result = await h.pending;
    expect(result).toMatchObject({ choice: "deny-once", rememberPattern: NO_APPROVER_MESSAGE });
    expect(isHostApprovalRejectedDecision(result)).toBe(true);
    expect(h.gate.pendingCount).toBe(0);
    expect(h.answer(h.second.contents)).toBeNull();
  });

  it("denies if the successor cannot receive the card", async () => {
    const h = fixture();
    vi.spyOn(h.second.contents, "send").mockImplementation(() => { throw new Error("Window unavailable"); });
    unregisterMainWindow(h.first.window);
    expect(await h.pending).toMatchObject({ choice: "deny-once", rememberPattern: NO_APPROVER_MESSAGE });
    expect(h.gate.pendingCount).toBe(0);
  });
});
