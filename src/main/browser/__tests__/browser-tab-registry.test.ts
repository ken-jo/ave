/**
 * The main-side browser tab registry: binding, window scope, provenance,
 * tab operations resolved by observation, user takeover and the active
 * surface hint.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTabRegistry, isUserActionInputType, type BrowserGuest } from "../browser-tab-registry.js";
import type { BrowserTabControlState, BrowserTabOpRequest } from "../../../shared/browser-surface.js";

class FakeGuest implements BrowserGuest {
  destroyed = false;
  constructor(readonly id: number, public url = "https://a.example/", public title = "A") {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
}

function setup() {
  const registry = new BrowserTabRegistry<FakeGuest>();
  const ops: Array<{ windowId: number; request: BrowserTabOpRequest }> = [];
  const control: Array<{ windowId: number; state: BrowserTabControlState }> = [];
  registry.setRendererLink({
    sendTabOp: (windowId, request) => {
      ops.push({ windowId, request });
      return true;
    },
    sendControl: (windowId, state) => control.push({ windowId, state }),
  });
  return { registry, ops, control };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserTabRegistry", () => {
  it("binds a tab only to a live guest attached to the sender's own window", () => {
    const { registry } = setup();
    const guest = new FakeGuest(11);
    registry.guestAttached(guest, 1);
    expect(registry.bindTab(2, { tabId: "browser:1", webContentsId: 11 })).toEqual({ ok: false, error: "guest-not-hosted" });
    expect(registry.bindTab(1, { tabId: "browser:1", webContentsId: 99 })).toEqual({ ok: false, error: "guest-not-live" });
    expect(registry.bindTab(1, { tabId: "browser:1", webContentsId: 11 })).toEqual({ ok: true });
    expect(registry.listTabs(1)).toEqual([
      { tabId: "tab-1", url: "https://a.example/", title: "A", openedBy: "user", active: false },
    ]);
  });

  it("keeps a tab's handle and provenance when it is remounted with a new guest", () => {
    const { registry } = setup();
    registry.guestAttached(new FakeGuest(11), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 11 });
    registry.guestDestroyed(11);
    expect(registry.listTabs(1)).toEqual([]);
    registry.guestAttached(new FakeGuest(12, "https://b.example/"), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 12 });
    expect(registry.listTabs(1).map((tab) => [tab.tabId, tab.url])).toEqual([["tab-1", "https://b.example/"]]);
  });

  it("answers another window's tab exactly like a missing one", () => {
    const { registry } = setup();
    registry.guestAttached(new FakeGuest(11), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 11 });
    expect(registry.liveTabInWindow("tab-1", 1)?.handle).toBe("tab-1");
    expect(registry.liveTabInWindow("tab-1", 2)).toBeUndefined();
    expect(registry.liveTabInWindow("tab-404", 1)).toBeUndefined();
    expect(registry.listTabs(2)).toEqual([]);
  });

  it("marks a tab the agent's only when the bind echoes main's own new-tab request", async () => {
    const { registry, ops, control } = setup();
    // A renderer-invented request id is just a user tab.
    registry.guestAttached(new FakeGuest(10), 1);
    registry.bindTab(1, { tabId: "browser:0", webContentsId: 10, requestId: "made-up" });
    expect(registry.liveTab("tab-1")?.opener).toBe("user");

    const opened = registry.requestTabOp(1, { op: "new", url: "https://a.example/" });
    expect(ops.at(-1)).toMatchObject({ windowId: 1, request: { op: "new", url: "about:blank" } });
    const requestId = ops.at(-1)!.request.requestId;
    registry.guestAttached(new FakeGuest(11, "about:blank"), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 11, requestId });
    await expect(opened).resolves.toEqual({ ok: true, tabId: "tab-2" });
    expect(registry.liveTab("tab-2")?.opener).toBe("agent");
    expect(control.at(-1)).toEqual({ windowId: 1, state: { agentControlledTabIds: ["browser:1"] } });
  });

  it("does not let another window's bind claim a new-tab request", async () => {
    vi.useFakeTimers();
    const { registry, ops } = setup();
    const opened = registry.requestTabOp(1, { op: "new", url: "https://a.example/" }, { timeoutMs: 1000 });
    registry.guestAttached(new FakeGuest(21), 2);
    registry.bindTab(2, { tabId: "browser:1", webContentsId: 21, requestId: ops.at(-1)!.request.requestId });
    expect(registry.liveTab("tab-1")?.opener).toBe("user");
    vi.advanceTimersByTime(1000);
    await expect(opened).resolves.toEqual({ ok: false, error: "timeout" });
  });

  it("resolves close when the guest goes away and select when the tab is shown", async () => {
    const { registry, ops } = setup();
    registry.guestAttached(new FakeGuest(11), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 11 });

    const selected = registry.requestTabOp(1, { op: "select", tabId: "tab-1" });
    expect(ops.at(-1)?.request).toMatchObject({ op: "select", tabId: "browser:1" });
    registry.setActiveSurface(1, { kind: "browser", tabId: "browser:1" });
    await expect(selected).resolves.toEqual({ ok: true, tabId: "tab-1" });
    expect(registry.activeBrowserTab(1)).toBe("tab-1");
    expect(registry.listTabs(1)[0]?.active).toBe(true);

    const closed = registry.requestTabOp(1, { op: "close", tabId: "tab-1" });
    registry.guestDestroyed(11);
    await expect(closed).resolves.toEqual({ ok: true, tabId: "tab-1" });
    expect(registry.activeBrowserTab(1)).toBeUndefined();
  });

  it("refuses an operation on a tab outside the window, and fails without a renderer", async () => {
    const { registry } = setup();
    await expect(registry.requestTabOp(1, { op: "close", tabId: "tab-9" })).resolves.toEqual({ ok: false, error: "no-such-tab" });
    registry.setRendererLink(null);
    await expect(registry.requestTabOp(1, { op: "new", url: "https://a.example/" })).resolves.toEqual({ ok: false, error: "no-window-renderer" });
  });

  it("cancels an agent tab's pending actions on user input, but not on its own injected input", async () => {
    const { registry, ops } = setup();
    const opened = registry.requestTabOp(1, { op: "new", url: "https://a.example/" });
    registry.guestAttached(new FakeGuest(11, "about:blank"), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 11, requestId: ops.at(-1)!.request.requestId });
    await opened;
    const tab = registry.liveTab("tab-1")!;

    const first = tab.actions.signal;
    await registry.withAgentInput(11, async () => registry.userInput(11, { type: "keyDown", _modifiers: 1 << 23 }));
    expect(first.aborted).toBe(false);

    registry.userInput(11);
    expect(first.aborted).toBe(true);
    expect(tab.actions.signal.aborted).toBe(false);
  });

  it("cancels user-tab work on input; stop releases an agent tab to the user", async () => {
    const { registry, ops, control } = setup();
    registry.guestAttached(new FakeGuest(10), 1);
    registry.bindTab(1, { tabId: "browser:0", webContentsId: 10 });
    const userSignal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(10);
    expect(userSignal.aborted).toBe(true);

    const opened = registry.requestTabOp(1, { op: "new", url: "https://a.example/" });
    registry.guestAttached(new FakeGuest(11, "about:blank"), 1);
    registry.bindTab(1, { tabId: "browser:1", webContentsId: 11, requestId: ops.at(-1)!.request.requestId });
    await opened;
    const agentSignal = registry.liveTab("tab-2")!.actions.signal;
    expect(registry.stop(1, "browser:1")).toBe(true);
    expect(agentSignal.aborted).toBe(true);
    expect(registry.liveTab("tab-2")?.opener).toBe("user");
    expect(control.at(-1)).toEqual({ windowId: 1, state: { agentControlledTabIds: [] } });
    expect(registry.stop(2, "browser:1")).toBe(false);
  });

  it("keeps the active surface per window and reports the active terminal", () => {
    const { registry } = setup();
    registry.setActiveSurface(1, { kind: "terminal", tabId: "terminal:3" });
    expect(registry.activeTerminalTabId(1)).toBe("terminal:3");
    expect(registry.activeTerminalTabId(2)).toBeUndefined();
    expect(registry.activeBrowserTab(1)).toBeUndefined();
    registry.setActiveSurface(1, null);
    expect(registry.activeTerminalTabId(1)).toBeUndefined();
  });

  it("counts key presses, clicks and wheel as user action, not hover", () => {
    expect(["keyDown", "rawKeyDown", "char", "mouseDown", "mouseWheel"].every(isUserActionInputType)).toBe(true);
    expect(["mouseMove", "mouseEnter", "mouseLeave", "keyUp", "mouseUp"].some(isUserActionInputType)).toBe(false);
  });

  it("asks the tab's window to give focus back after an action", async () => {
    const { registry, ops } = setup();
    registry.guestAttached(new FakeGuest(10), 1);
    registry.bindTab(1, { tabId: "browser:0", webContentsId: 10 });
    registry.releaseFocus(10);
    expect(ops.at(-1)).toMatchObject({ windowId: 1, request: { op: "restore-focus", tabId: "browser:0" } });
    const before = ops.length;
    registry.releaseFocus(99);
    expect(ops).toHaveLength(before);
  });
});

describe("injected interval intervention", () => {
  it("cancels genuine user input while an injection is pending", async () => {
    const { registry, ops } = setup();
    const opening = registry.requestTabOp(1, { op: "new", url: "https://a.example/" });
    registry.guestAttached(new FakeGuest(91, "about:blank"), 1);
    registry.bindTab(1, { tabId: "browser:agent", webContentsId: 91, requestId: ops.at(-1)!.request.requestId });
    await opening;
    const signal = registry.liveTab("tab-1")!.actions.signal;
    await registry.withAgentInput(91, async () => {
      registry.userInput(91);
      expect(signal.aborted).toBe(true);
    });
  });

  it("bootstraps an agent-created view without issuing the approved URL first", async () => {
    const { registry, ops } = setup();
    const opening = registry.requestTabOp(1, { op: "new", url: "https://a.example/redirect" });
    expect(ops.at(-1)?.request).toMatchObject({ op: "new", url: "about:blank" });
    registry.guestAttached(new FakeGuest(91, "about:blank"), 1);
    registry.bindTab(1, { tabId: "browser:agent", webContentsId: 91, requestId: ops.at(-1)!.request.requestId });
    await opening;
  });

  it("requires site approval again when an agent tab reaches another origin", async () => {
    const { registry, ops } = setup();
    const opening = registry.requestTabOp(1, { op: "new", url: "https://a.example/" });
    const guest = new FakeGuest(91, "about:blank");
    registry.guestAttached(guest, 1);
    registry.bindTab(1, { tabId: "browser:agent", webContentsId: 91, requestId: ops.at(-1)!.request.requestId });
    await opening;
    guest.url = "https://b.example/";
    expect(registry.liveTab("tab-1")!.opener).toBe("user");
  });
});

describe("concrete new-tab attachment", () => {
  it("cancels pending work in a user-owned tab on intervention", () => {
    const { registry } = setup();
    registry.guestAttached(new FakeGuest(1), 1);
    registry.bindTab(1, { tabId: "user", webContentsId: 1 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(1);
    expect(signal.aborted).toBe(true);
  });
  it.each(["bound", "old-blank", "nonblank"])("does not promote a %s guest through a new-tab request", async (kind) => {
    vi.useFakeTimers();
    const { registry, ops } = setup();
    if (kind !== "nonblank") registry.guestAttached(new FakeGuest(1, "about:blank"), 1);
    if (kind === "bound") registry.bindTab(1, { tabId: "user", webContentsId: 1 });
    const opening = registry.requestTabOp(1, { op: "new", url: "https://a.example/" }, { timeoutMs: 20 });
    if (kind === "nonblank") registry.guestAttached(new FakeGuest(1), 1);
    expect(registry.bindTab(1, { tabId: kind === "bound" ? "user" : "new", webContentsId: 1, requestId: ops.at(-1)!.request.requestId }))
      .toEqual({ ok: false, error: "guest-not-hosted" });
    vi.advanceTimersByTime(20);
    await expect(opening).resolves.toEqual({ ok: false, error: "timeout" });
    expect(registry.liveTab("tab-1")?.opener).not.toBe("agent");
  });
});

describe("native injected touch attribution", () => {
  it("matches only the marked touch's derived tap sequence", () => {
    const { registry } = setup();
    registry.guestAttached(new FakeGuest(11), 1);
    registry.bindTab(1, { tabId: "user", webContentsId: 11 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(11, { type: "touchStart", _modifiers: 1 << 23 });
    registry.userInput(11, { type: "gestureTapDown", _modifiers: 1 << 25 });
    registry.userInput(11, { type: "touchEnd", _modifiers: 1 << 23 });
    registry.userInput(11, { type: "gestureShowPress", _modifiers: 1 << 25 });
    registry.userInput(11, { type: "gestureTap", _modifiers: 1 << 25 });
    expect(signal.aborted).toBe(false);
    registry.userInput(11, { type: "gestureTap", _modifiers: 1 << 25 });
    expect(signal.aborted).toBe(true);
  });
  it.each(["mouseDown", "keyDown", "touchStart", "gestureTapDown", "gestureScrollBegin", "pointerDown"])("cancels unmarked %s during a marked touch sequence", (type) => {
    const { registry } = setup();
    registry.guestAttached(new FakeGuest(11), 1);
    registry.bindTab(1, { tabId: "user", webContentsId: 11 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(11, { type: "touchStart", _modifiers: 1 << 23 });
    registry.userInput(11, { type });
    expect(signal.aborted).toBe(true);
  });
});
