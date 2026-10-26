import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopHostFixture } from "../../__tests__/support/host-runtime.js";
import {
  findSessionMainWindowContents,
  getMainWindow,
  getMainWindows,
  markMainWindowFocused,
  registerMainWindow,
  resetMainWindowsForTests,
  setSessionContentsLookup,
  setSideChatOwnerContents,
  unregisterMainWindow,
} from "../../main/app-state.js";
import { createRootSessionResolver } from "../../permissions/root-session-resolver.js";
import { setApprovalConversationRootResolver } from "../../permissions/user-approval-store.js";
import { approvalSurfaceResolver } from "../approval-surface.js";

vi.mock("../../main/terminal/pty-manager.js", () => ({ terminalOwnerWindowId: () => undefined }));

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "sub-11111111-22222222-2222-4222-8222-222222222222";
const GRANDCHILD = "sub-22222222-33333333-3333-4333-8333-333333333333";

function windowFixture(id: number) {
  const state = { destroyed: false, contentsDestroyed: false };
  const contents = { id: id * 100, isDestroyed: () => state.contentsDestroyed } as WebContents;
  const window = { id, webContents: contents, isDestroyed: () => state.destroyed } as BrowserWindow;
  registerMainWindow(window, id === 1 ? "primary" : "secondary");
  return { window, contents, state };
}

function resolverFixture() {
  const sessions = new Map<string, WebContents>();
  setSessionContentsLookup((sessionId) => sessions.get(sessionId) ?? null);
  const terminals = new Map<string, WebContents>();
  const desktop = createDesktopHostFixture({
    getAppWindows: getMainWindows,
    findSessionSurface: findSessionMainWindowContents,
    findTerminalSurface: (tabId) => terminals.get(tabId) ?? null,
  });
  const conversations: {
    sideChatConversationLoop?: { getSessionId(): string };
    paneChatLoops?: { holding(sessionId: string): { windowId: number } | undefined };
  } = {};
  return {
    sessions,
    terminals,
    conversations,
    resolve: approvalSurfaceResolver({ desktop }, getMainWindow, conversations),
  };
}

describe("approval surface ownership", () => {
  beforeEach(() => resetMainWindowsForTests());
  afterEach(() => {
    resetMainWindowsForTests();
    setApprovalConversationRootResolver((sessionId) => sessionId);
  });

  it("keeps attributed approvals with their exact owner when another window gains focus", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { sessions, resolve } = resolverFixture();
    sessions.set(ROOT, first.contents);
    expect(getMainWindow()).toBe(second.window);
    expect(resolve(ROOT)).toBe(first.contents);
    markMainWindowFocused(first.window);
    sessions.set(ROOT, second.contents);
    expect(resolve(ROOT)).toBe(second.contents);
  });

  it("reads moves and releases from the current holder instead of retaining the creation owner", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { sessions, resolve } = resolverFixture();
    sessions.set(ROOT, first.contents);
    expect(resolve(ROOT)).toBe(first.contents);
    sessions.set(ROOT, second.contents);
    expect(resolve(ROOT)).toBe(second.contents);
    sessions.delete(ROOT);
    expect(resolve(ROOT)).toBeNull();
  });

  it("does not assign an unhosted or closed conversation to the active window", () => {
    const first = windowFixture(1);
    windowFixture(2);
    const { sessions, resolve } = resolverFixture();
    expect(resolve(ROOT)).toBeNull();
    sessions.set(ROOT, first.contents);
    first.state.contentsDestroyed = true;
    expect(resolve(ROOT)).toBeNull();
    first.state.contentsDestroyed = false;
    unregisterMainWindow(first.window);
    expect(resolve(ROOT)).toBeNull();
  });

  it("resolves restored descendants through the canonical root and follows its current owner", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { sessions, resolve } = resolverFixture();
    const ancestry: Record<string, string> = {};
    setApprovalConversationRootResolver(createRootSessionResolver((sessionId) => ancestry[sessionId]));
    sessions.set(ROOT, first.contents);
    expect(resolve(CHILD)).toBeNull();
    ancestry[CHILD] = ROOT;
    ancestry[GRANDCHILD] = CHILD;
    expect(resolve(CHILD)).toBe(first.contents);
    expect(resolve(GRANDCHILD)).toBe(first.contents);
    sessions.set(ROOT, second.contents);
    expect(resolve(GRANDCHILD)).toBe(second.contents);
  });

  it("preserves contract errors for invalid or cyclic ancestry and empty session identities", () => {
    windowFixture(1);
    const { resolve } = resolverFixture();
    setApprovalConversationRootResolver(createRootSessionResolver(() => "../foreign"));
    expect(() => resolve(CHILD)).toThrow("Session ancestry contains an invalid origin");
    setApprovalConversationRootResolver(createRootSessionResolver(() => CHILD));
    expect(() => resolve(CHILD)).toThrow("Session ancestry contains a cycle");
    expect(() => resolve("")).toThrow("Approval session identity must be non-empty");
    setApprovalConversationRootResolver(() => " ");
    expect(() => resolve(ROOT)).toThrow("Approval root session identity must be non-empty");
  });

  it("reads the rail session and owner lazily after conversation wiring", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { conversations, resolve } = resolverFixture();
    setSideChatOwnerContents(first.contents);
    expect(resolve(ROOT)).toBeNull();
    let railSession = ROOT;
    conversations.sideChatConversationLoop = { getSessionId: () => railSession };
    expect(resolve(ROOT)).toBe(first.contents);
    setSideChatOwnerContents(second.contents);
    expect(resolve(ROOT)).toBe(second.contents);
    setSideChatOwnerContents(null);
    expect(resolve(ROOT)).toBeNull();
    setSideChatOwnerContents(first.contents);
    railSession = CHILD;
    expect(resolve(ROOT)).toBeNull();
    railSession = ROOT;
    first.state.contentsDestroyed = true;
    expect(resolve(ROOT)).toBeNull();
  });

  it("reads current pane ownership and refuses released, unknown or destroyed windows", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { conversations, resolve } = resolverFixture();
    let pane: { windowId: number } | undefined = { windowId: first.window.id };
    conversations.paneChatLoops = { holding: (sessionId) => sessionId === ROOT ? pane : undefined };
    expect(resolve(ROOT)).toBe(first.contents);
    pane = { windowId: second.window.id };
    expect(resolve(ROOT)).toBe(second.contents);
    second.state.contentsDestroyed = true;
    expect(resolve(ROOT)).toBeNull();
    second.state.contentsDestroyed = false;
    second.state.destroyed = true;
    expect(resolve(ROOT)).toBeNull();
    pane = { windowId: 999 };
    expect(resolve(ROOT)).toBeNull();
    pane = undefined;
    expect(resolve(ROOT)).toBeNull();
  });

  it("prioritizes an exact main-chat holder over rail and pane context", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { sessions, conversations, resolve } = resolverFixture();
    sessions.set(ROOT, first.contents);
    setSideChatOwnerContents(second.contents);
    conversations.sideChatConversationLoop = { getSessionId: () => ROOT };
    conversations.paneChatLoops = { holding: () => ({ windowId: second.window.id }) };
    expect(resolve(ROOT)).toBe(first.contents);
  });

  it("uses only the terminal tab owner when a terminal identity is supplied", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { sessions, terminals, resolve } = resolverFixture();
    sessions.set(ROOT, second.contents);
    terminals.set("terminal", first.contents);
    expect(resolve(ROOT, "terminal")).toBe(first.contents);
    terminals.delete("terminal");
    expect(resolve(ROOT, "terminal")).toBeNull();
    expect(resolve(undefined, "terminal")).toBeNull();
  });

  it("retains active-window routing only for unattributed approvals", () => {
    const first = windowFixture(1);
    const second = windowFixture(2);
    const { resolve } = resolverFixture();
    expect(resolve(undefined)).toBe(second.contents);
    markMainWindowFocused(first.window);
    expect(resolve(undefined)).toBe(first.contents);
    first.state.contentsDestroyed = true;
    expect(resolve(undefined)).toBeNull();
  });

  it("returns no desktop authority in a headless host even if a window getter exists", () => {
    const first = windowFixture(1);
    const getWindow = vi.fn(() => first.window);
    const resolve = approvalSurfaceResolver({}, getWindow, {});
    expect(resolve(ROOT)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve(ROOT, "terminal")).toBeNull();
    expect(getWindow).not.toHaveBeenCalled();
  });
});
