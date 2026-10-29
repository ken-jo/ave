import { deferred } from "../../../__tests__/support/deferred.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserDocumentChangedError, BrowserTabRegistry, isUserActionInputType, type BrowserGuest } from "../browser-tab-registry.js";
import { parseBrowserTabControlState, parseBrowserTabOpRequest, type BrowserTabControlState, type BrowserTabOpRequest } from "../../../shared/browser-surface.js";

const ACTOR = { sessionId: "conversation" };

class FakeGuest implements BrowserGuest {
  destroyed = false;
  focused = false;
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
  isFocused(): boolean { return this.focused; }
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
    isWindowVisible: () => true,
  });
  return { registry, ops, control };
}

function attachTab(
  registry: BrowserTabRegistry<FakeGuest>,
  binding: Parameters<BrowserTabRegistry<FakeGuest>["bindTab"]>[1],
  windowId = 1,
  url?: string,
) {
  registry.guestAttached(new FakeGuest(binding.webContentsId, url), windowId);
  registry.bindTab(windowId, binding);
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
    expect(registry.listTabs(1)).toMatchObject([
      { tabId: "tab-1", url: "https://a.example/", title: "A", openedBy: "user", active: false },
    ]);
  });

  it("keeps a tab's handle and provenance when it is remounted with a new guest", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "browser:1", webContentsId: 11 });
    registry.guestDestroyed(11);
    expect(registry.listTabs(1)).toEqual([]);
    attachTab(registry, { tabId: "browser:1", webContentsId: 12 }, 1, "https://b.example/");
    expect(registry.listTabs(1).map((tab) => [tab.tabId, tab.url])).toEqual([["tab-1", "https://b.example/"]]);
  });

  it("answers another window's tab exactly like a missing one", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "browser:1", webContentsId: 11 });
    expect(registry.liveTabInWindow("tab-1", 1)?.handle).toBe("tab-1");
    expect(registry.liveTabInWindow("tab-1", 2)).toBeUndefined();
    expect(registry.liveTabInWindow("tab-404", 1)).toBeUndefined();
    expect(registry.listTabs(2)).toEqual([]);
  });

  it("marks a tab the agent's only when the bind echoes main's own new-tab request", async () => {
    const { registry, ops, control } = setup();
    // A renderer-invented request id is just a user tab.
    attachTab(registry, { tabId: "browser:0", webContentsId: 10, requestId: "made-up" });
    expect(registry.liveTab("tab-1")?.opener).toBe("user");

    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" });
    expect(ops.at(-1)).toMatchObject({ windowId: 1, request: { op: "new", url: "about:blank" } });
    const requestId = ops.at(-1)!.request.requestId;
    attachTab(registry, { tabId: "browser:1", webContentsId: 11, requestId }, 1, "about:blank");
    await expect(opened).resolves.toEqual({ ok: true, tabId: "tab-2" });
    expect(registry.liveTab("tab-2")?.opener).toBe("agent");
    expect(control.at(-1)).toMatchObject({ windowId: 1, state: { revision: expect.any(Number), tabs: [
      { rendererTabId: "browser:0", mode: "human", owner: null },
      { rendererTabId: "browser:1", mode: "agent-active", owner: ACTOR },
    ] } });
  });

  it("keeps an unknown tab user-owned when takeover arrives before its first bind", async () => {
    const { registry, ops } = setup();
    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" });
    const requestId = ops.at(-1)!.request.requestId;
    registry.stop(1, "browser:restoring");
    registry.guestAttached(new FakeGuest(11, "about:blank"), 1);
    expect(registry.bindTab(1, { tabId: "browser:restoring", webContentsId: 11, requestId })).toEqual({ ok: true });
    await expect(opened).resolves.toEqual({ ok: false, error: "aborted" });
    expect(registry.liveTab("tab-1")?.opener).toBe("user");
    expect(registry.liveTab("tab-1")?.agentOrigin).toBeNull();
  });

  it.each(["https://a.example/user-chosen", "https://b.example/user-chosen"])("binds a user-navigated bootstrap after takeover without granting agent control (%s)", async (url) => {
    const { registry, ops, control } = setup();
    const abort = new AbortController();
    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" }, { signal: abort.signal });
    const requestId = ops.at(-1)!.request.requestId;
    try {
      expect(registry.stop(1, "browser:early")).toBe(true);
      registry.guestAttached(new FakeGuest(31, url), 1);
      expect(registry.bindTab(1, { tabId: "browser:early", webContentsId: 31, requestId })).toEqual({ ok: true });
      await expect(opened).resolves.toEqual({ ok: false, error: "aborted" });
      expect(registry.listTabs(1)).toMatchObject([{ tabId: "tab-1", url, title: "A", openedBy: "user", active: false }]);
      expect(registry.liveTab("tab-1")?.agentOrigin).toBeNull();
      expect(control.at(-1)?.state.tabs[0]).toMatchObject({ mode: "human-paused", owner: ACTOR, lease: null });
    } finally {
      abort.abort();
      await opened;
    }
  });

  it.each(["tab", "window"])("does not relax bootstrap provenance for a takeover in another %s", async (scope) => {
    const { registry, ops } = setup();
    const abort = new AbortController();
    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" }, { signal: abort.signal });
    try {
      registry.stop(scope === "window" ? 2 : 1, scope === "tab" ? "browser:other" : "browser:early");
      registry.guestAttached(new FakeGuest(31, "https://a.example/user-chosen"), 1);
      expect(registry.bindTab(1, { tabId: "browser:early", webContentsId: 31, requestId: ops.at(-1)!.request.requestId }))
        .toEqual({ ok: false, error: "guest-not-hosted" });
      expect(registry.listTabs(1)).toEqual([]);
    } finally {
      abort.abort();
      await opened;
    }
  });

  it("does not let another window's bind claim a new-tab request", async () => {
    vi.useFakeTimers();
    const { registry, ops } = setup();
    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" }, { timeoutMs: 1000 });
    attachTab(registry, { tabId: "browser:1", webContentsId: 21, requestId: ops.at(-1)!.request.requestId }, 2);
    expect(registry.liveTab("tab-1")?.opener).toBe("user");
    vi.advanceTimersByTime(1000);
    await expect(opened).resolves.toEqual({ ok: false, error: "timeout" });
  });

  it("resolves close when the guest goes away and select when the tab is shown", async () => {
    const { registry, ops } = setup();
    attachTab(registry, { tabId: "browser:1", webContentsId: 11 });

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
    await expect(registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" })).resolves.toEqual({ ok: false, error: "no-window-renderer" });
  });

  it("cancels an agent tab's pending actions on user input, but not on its own injected input", async () => {
    const { registry, ops } = setup();
    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" });
    attachTab(registry, { tabId: "browser:1", webContentsId: 11, requestId: ops.at(-1)!.request.requestId }, 1, "about:blank");
    await opened;
    const tab = registry.liveTab("tab-1")!;

    const first = tab.actions.signal;
    await registry.withAgentInput(11, async () => registry.userInput(11, { type: "keyDown", _modifiers: 1 << 23 }));
    expect(first.aborted).toBe(false);

    registry.userInput(11);
    expect(first.aborted).toBe(true);
    expect(tab.actions.signal.aborted).toBe(true);
    expect(tab.controlMode).toBe("human-paused");
  });

  it("cancels user-tab work on input; Stop pauses agent control while preserving its creator", async () => {
    const { registry, ops, control } = setup();
    attachTab(registry, { tabId: "browser:0", webContentsId: 10 });
    const userSignal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(10);
    expect(userSignal.aborted).toBe(true);

    const opened = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" });
    attachTab(registry, { tabId: "browser:1", webContentsId: 11, requestId: ops.at(-1)!.request.requestId }, 1, "about:blank");
    await opened;
    const agentSignal = registry.liveTab("tab-2")!.actions.signal;
    expect(registry.stop(1, "browser:1")).toBe(true);
    expect(agentSignal.aborted).toBe(true);
    expect(registry.liveTab("tab-2")?.opener).toBe("user");
    expect(control.at(-1)?.state.tabs[1]).toMatchObject({ mode: "human-paused", owner: ACTOR });
    const currentSignal = registry.liveTab("tab-2")!.actions.signal;
    expect(registry.stop(2, "browser:1")).toBe(true);
    expect(registry.liveTab("tab-2")!.actions.signal).toBe(currentSignal);
  });

  it("keeps the active surface per window", () => {
    const { registry } = setup();
    registry.setActiveSurface(1, { kind: "terminal", tabId: "terminal:3" });
    expect(registry.getActiveSurface(1)).toEqual({ kind: "terminal", tabId: "terminal:3" });
    expect(registry.getActiveSurface(2)).toBeUndefined();
    expect(registry.activeBrowserTab(1)).toBeUndefined();
    registry.setActiveSurface(1, null);
    expect(registry.getActiveSurface(1)).toBeUndefined();
  });

  it("counts key presses, clicks and wheel as user action, not hover", () => {
    expect(["keyDown", "rawKeyDown", "char", "mouseDown", "mouseWheel"].every(isUserActionInputType)).toBe(true);
    expect(["mouseMove", "mouseEnter", "mouseLeave", "keyUp", "mouseUp"].some(isUserActionInputType)).toBe(false);
  });

  it("asks the tab's window to give focus back after an action", async () => {
    const { registry, ops } = setup();
    attachTab(registry, { tabId: "browser:0", webContentsId: 10 });
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
    const opening = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" });
    attachTab(registry, { tabId: "browser:agent", webContentsId: 91, requestId: ops.at(-1)!.request.requestId }, 1, "about:blank");
    await opening;
    const signal = registry.liveTab("tab-1")!.actions.signal;
    await registry.withAgentInput(91, async () => {
      registry.userInput(91);
      expect(signal.aborted).toBe(true);
    });
  });

  it("bootstraps an agent-created view without issuing the approved URL first", async () => {
    const { registry, ops } = setup();
    const opening = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/redirect" });
    expect(ops.at(-1)?.request).toMatchObject({ op: "new", url: "about:blank" });
    attachTab(registry, { tabId: "browser:agent", webContentsId: 91, requestId: ops.at(-1)!.request.requestId }, 1, "about:blank");
    await opening;
  });

  it("requires site approval again when an agent tab reaches another origin", async () => {
    const { registry, ops } = setup();
    const opening = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" });
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
    attachTab(registry, { tabId: "user", webContentsId: 1 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(1);
    expect(signal.aborted).toBe(true);
  });
  it.each(["bound", "old-blank", "nonblank"])("does not promote a %s guest through a new-tab request", async (kind) => {
    vi.useFakeTimers();
    const { registry, ops } = setup();
    if (kind !== "nonblank") registry.guestAttached(new FakeGuest(1, "about:blank"), 1);
    if (kind === "bound") registry.bindTab(1, { tabId: "user", webContentsId: 1 });
    const opening = registry.requestTabOp(1, { op: "new", actor: ACTOR, url: "https://a.example/" }, { timeoutMs: 20 });
    // Revocation does not relax attachment identity or freshness checks.
    if (kind !== "nonblank") registry.stop(1, kind === "bound" ? "user" : "new");
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
    attachTab(registry, { tabId: "user", webContentsId: 11 });
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
  // Measured in the app (Electron on macOS, window in the background): the gestures derived from an injected touch arrive with no modifiers at all.
  // Treating them as the user's own taps cancelled every agent click and type.
  it("matches the derived tap sequence when it carries no modifiers", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "user", webContentsId: 11 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(11, { type: "touchStart", _modifiers: 1 << 23 });
    registry.userInput(11, { type: "gestureTapDown", _modifiers: 0 });
    registry.userInput(11, { type: "touchMove", _modifiers: 1 << 23 });
    registry.userInput(11, { type: "touchEnd", _modifiers: 1 << 23 });
    registry.userInput(11, { type: "gestureShowPress", _modifiers: 0 });
    registry.userInput(11, { type: "gestureTap", _modifiers: 0 });
    expect(signal.aborted).toBe(false);
    registry.userInput(11, { type: "gestureTap", _modifiers: 0 });
    expect(signal.aborted).toBe(true);
  });
  it("cancels a tap gesture with no marked touch before it", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "user", webContentsId: 11 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(11, { type: "gestureTapDown", _modifiers: 0 });
    expect(signal.aborted).toBe(true);
  });
  it("cancels a tap gesture carrying a keyboard modifier during a marked touch sequence", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "user", webContentsId: 11 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(11, { type: "touchStart", _modifiers: 1 << 23 });
    registry.userInput(11, { type: "gestureTapDown", _modifiers: 1 << 1 });
    expect(signal.aborted).toBe(true);
  });
  it.each(["mouseDown", "keyDown", "touchStart", "gestureScrollBegin", "gestureTapCancel", "pointerDown"])("cancels unmarked %s during a marked touch sequence", (type) => {
    const { registry } = setup();
    attachTab(registry, { tabId: "user", webContentsId: 11 });
    const signal = registry.liveTab("tab-1")!.actions.signal;
    registry.userInput(11, { type: "touchStart", _modifiers: 1 << 23 });
    registry.userInput(11, { type });
    expect(signal.aborted).toBe(true);
  });
});

describe("a conversation bound to a pane's tab", () => {
  function twoPages() {
    const { registry } = setup();
    attachTab(registry, { tabId: "browser:pane", webContentsId: 11 });
    attachTab(registry, { tabId: "browser:side", webContentsId: 12 });
    // The window's active surface is the OTHER page.
    registry.setActiveSurface(1, { kind: "browser", tabId: "browser:side" });
    return registry;
  }

  it("defaults its browser tools to the bound tab, not the window's active one", () => {
    const registry = twoPages();
    registry.bindConversationSurface("side-chat", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    expect(registry.defaultBrowserTab(1, "side-chat")).toEqual({ ok: true, handle: "tab-1" });
    // An unbound conversation still follows the window's active surface.
    expect(registry.defaultBrowserTab(1, "main")).toEqual({ ok: true, handle: "tab-2" });
  });

  it("fails clearly, never falling back to another tab, when the bound page is gone", () => {
    const registry = twoPages();
    registry.bindConversationSurface("side-chat", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    registry.guestDestroyed(11);
    const result = registry.defaultBrowserTab(1, "side-chat");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("bound to is closed") });
  });

  it("keeps a terminal pane binding separate from the active surface and refuses a default page", () => {
    const registry = twoPages();
    registry.setActiveSurface(1, { kind: "terminal", tabId: "terminal:active" });
    registry.bindConversationSurface("side-chat", { windowId: 1, surface: { kind: "terminal", tabId: "terminal:pane" } });
    expect(registry.defaultBrowserTab(1, "side-chat")).toMatchObject({ ok: false, error: expect.stringContaining("bound to a terminal") });
    expect(registry.conversationSurface(1, "side-chat")).toEqual({ kind: "terminal", tabId: "terminal:pane" });
    expect(registry.conversationSurface(1, "main")).toBeUndefined();
    expect(registry.getActiveSurface(1)).toEqual({ kind: "terminal", tabId: "terminal:active" });
  });

  it("is scoped to its window and released when the pane chat ends", () => {
    const registry = twoPages();
    registry.bindConversationSurface("side-chat", { windowId: 2, surface: { kind: "browser", tabId: "browser:pane" } });
    expect(registry.conversationSurface(1, "side-chat")).toBeUndefined();
    expect(registry.paneConversation(1, "browser:pane")).toBeUndefined();
    registry.bindConversationSurface("side-chat", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    expect(registry.paneConversation(1, "browser:pane")).toBe("side-chat");
    expect(registry.releasePaneConversation(1, "browser:pane")).toBe("side-chat");
    expect(registry.isPaneConversation("side-chat")).toBe(false);
    expect(registry.defaultBrowserTab(1, "side-chat")).toEqual({ ok: true, handle: "tab-2" });
  });

  it("holds one conversation per pane: binding a new one releases the pane's last", () => {
    const registry = twoPages();
    registry.bindConversationSurface("first", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    registry.bindConversationSurface("other-pane", { windowId: 1, surface: { kind: "browser", tabId: "browser:side" } });
    registry.bindConversationSurface("second", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    expect(registry.paneConversation(1, "browser:pane")).toBe("second");
    expect(registry.isPaneConversation("first")).toBe(false);
    expect(registry.paneConversation(1, "browser:side")).toBe("other-pane");
  });

  it("knows an agent is closing a bound pane's tab, and forgets it once the pane chat ends", async () => {
    const registry = twoPages();
    registry.bindConversationSurface("side-chat", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    const closing = registry.requestTabOp(1, { op: "close", tabId: "tab-1" });
    expect(registry.isClosedByAgent(1, "browser:pane")).toBe(true);
    // Another window's pane with the same id is not the one closing.
    expect(registry.isClosedByAgent(2, "browser:pane")).toBe(false);
    registry.guestDestroyed(11);
    await expect(closing).resolves.toEqual({ ok: true, tabId: "tab-1" });
    expect(registry.isClosedByAgent(1, "browser:pane")).toBe(true);
    registry.releasePaneConversation(1, "browser:pane");
    expect(registry.isClosedByAgent(1, "browser:pane")).toBe(false);
  });

  it("takes the mark back when the close does not happen, and never marks an unbound tab", async () => {
    const registry = twoPages();
    registry.bindConversationSurface("side-chat", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    const abort = new AbortController();
    const closing = registry.requestTabOp(1, { op: "close", tabId: "tab-1" }, { signal: abort.signal });
    abort.abort();
    await expect(closing).resolves.toEqual({ ok: false, error: "aborted" });
    expect(registry.isClosedByAgent(1, "browser:pane")).toBe(false);
    void registry.requestTabOp(1, { op: "close", tabId: "tab-2" });
    expect(registry.isClosedByAgent(1, "browser:side")).toBe(false);
  });

  it("drops every pane binding of a window that is gone, and only that window's", () => {
    const registry = twoPages();
    registry.bindConversationSurface("pane-one", { windowId: 1, surface: { kind: "browser", tabId: "browser:pane" } });
    registry.bindConversationSurface("pane-two", { windowId: 1, surface: { kind: "terminal", tabId: "terminal:pane" } });
    registry.bindConversationSurface("elsewhere", { windowId: 2, surface: { kind: "browser", tabId: "browser:pane" } });
    void registry.requestTabOp(1, { op: "close", tabId: "tab-1" });
    registry.releaseWindow(1);
    expect(registry.isPaneConversation("pane-one")).toBe(false);
    expect(registry.isPaneConversation("pane-two")).toBe(false);
    expect(registry.isClosedByAgent(1, "browser:pane")).toBe(false);
    expect(registry.paneConversation(2, "browser:pane")).toBe("elsewhere");
  });
});

describe("watching one press's touch input", () => {
  const MARK = 1 << 23;
  function windowWithTwoPages() {
    const { registry } = setup();
    attachTab(registry, { tabId: "browser:a", webContentsId: 11 });
    attachTab(registry, { tabId: "browser:c", webContentsId: 12 });
    attachTab(registry, { tabId: "browser:other-window", webContentsId: 13 }, 2);
    return registry;
  }
  const tap = (registry: BrowserTabRegistry<FakeGuest>, guestId: number) => {
    registry.userInput(guestId, { type: "touchStart", _modifiers: MARK });
    registry.userInput(guestId, { type: "gestureTapDown", _modifiers: 0 });
    registry.userInput(guestId, { type: "touchEnd", _modifiers: MARK });
    registry.userInput(guestId, { type: "gestureShowPress", _modifiers: 0 });
    registry.userInput(guestId, { type: "gestureTap", _modifiers: 0 });
  };

  it("reports a press that reached its own page, start to derived tap", () => {
    const registry = windowWithTwoPages();
    const watch = registry.watchTouches(11);
    tap(registry, 11);
    // Another window's touch is not this window's business.
    registry.userInput(13, { type: "touchStart", _modifiers: MARK });
    expect(watch.delivery()).toEqual({ started: true, ended: true, tapped: true, elsewhere: 0 });
    watch.stop();
  });

  it("counts a touch another page of the same window took meanwhile", () => {
    const registry = windowWithTwoPages();
    const watch = registry.watchTouches(11);
    registry.userInput(12, { type: "touchStart", _modifiers: MARK });
    expect(watch.delivery()).toEqual({ started: false, ended: false, tapped: false, elsewhere: 1 });
    watch.stop();
  });

  it("reads an unmarked touch as no press of the agent's", () => {
    const registry = windowWithTwoPages();
    const watch = registry.watchTouches(11);
    registry.userInput(11, { type: "touchStart", _modifiers: 0 });
    expect(watch.delivery().started).toBe(false);
    watch.stop();
  });

  it("keeps a delivered press's mark for its own late tap, and reads a later unmarked tap as the user's", async () => {
    const registry = windowWithTwoPages();
    const signal = registry.liveTab("tab-1")!.actions.signal;
    const watch = registry.watchTouches(11);
    registry.userInput(11, { type: "touchStart", _modifiers: MARK });
    registry.userInput(11, { type: "gestureTapDown", _modifiers: 0 });
    registry.userInput(11, { type: "touchEnd", _modifiers: MARK });
    watch.stop();
    registry.userInput(11, { type: "gestureShowPress", _modifiers: 0 });
    registry.userInput(11, { type: "gestureTap", _modifiers: 0 });
    expect(signal.aborted).toBe(false);
    registry.userInput(11, { type: "touchStart", _modifiers: 0 });
    expect(signal.aborted).toBe(true);
  });
});

describe("scoped browser control", () => {
  async function owned(actor = ACTOR, guestId = 71) {
    const state = setup();
    const opening = state.registry.requestTabOp(1, { op: "new", url: "https://a.example/", actor });
    const guest = new FakeGuest(guestId, "about:blank");
    state.registry.guestAttached(guest, 1);
    state.registry.bindTab(1, { tabId: "page", webContentsId: guestId, requestId: state.ops.at(-1)!.request.requestId });
    await opening;
    return { ...state, guest, tab: state.registry.liveTab("tab-1")! };
  }

  it("persists native takeover through new calls, document events and a remount until explicit Resume", async () => {
    const { registry, tab } = await owned();
    const lease = registry.acquireControl(tab, ACTOR);
    const generation = tab.controlGeneration;
    registry.userInput(71, { type: "keyDown" });
    expect(tab.actions.signal.aborted).toBe(true);
    expect(tab.controlGeneration).toBeGreaterThan(generation);
    registry.releaseControl(tab.handle, lease.id);
    registry.documentChanged(71);
    registry.navigationStarted(71, "https://b.example/");
    expect(() => registry.acquireControl(tab, ACTOR)).toThrow("browser control is paused; ask the user to resume this tab");
    registry.guestDestroyed(71);
    attachTab(registry, { tabId: "page", webContentsId: 72 }, 1, "https://b.example/");
    expect(tab).toMatchObject({ owner: ACTOR, controlMode: "human-paused", opener: "user", agentOrigin: null });
    expect(registry.resume(2, "page")).toBe(false);
    expect(registry.resume(1, "missing")).toBe(false);
    expect(registry.resume(1, "page")).toBe(true);
    expect(tab.actions.signal.aborted).toBe(false);
    expect(registry.acquireControl(tab, ACTOR).lifetime).toBe("owned");
  });

  it("does not let stale cleanup release a later lease after pause and resume", async () => {
    const { registry, tab } = await owned();
    const first = registry.acquireControl(tab, ACTOR);
    registry.pause(1, "page");
    registry.resume(1, "page");
    const second = registry.acquireControl(tab, ACTOR);
    registry.releaseControl(tab.handle, first.id);
    expect(tab.lease).toBe(second);
    expect(tab.controlMode).toBe("agent-active");
    registry.releaseControl(tab.handle, second.id);
    expect(tab).toMatchObject({ owner: ACTOR, lease: null, controlMode: "human" });
    expect(registry.listTabs(1)).toHaveLength(1);
  });

  it("preserves a sealed security epoch and action signal during lease acquisition", async () => {
    const { registry, tab } = await owned();
    const generation = tab.controlGeneration;
    const signal = tab.actions.signal;
    const lease = registry.acquireControl(tab, ACTOR);
    expect(tab.controlGeneration).toBe(generation);
    expect(tab.actions.signal).toBe(signal);
    expect(signal.aborted).toBe(false);
    registry.releaseControl(tab.handle, lease.id);
    expect(tab.controlGeneration).toBe(generation);
    expect(signal.aborted).toBe(true);
  });

  it("retains a borrowed user tab and releases only its caller association on agent close", async () => {
    const { registry, ops } = setup();
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    const tab = registry.liveTab("tab-1")!;
    const lease = registry.acquireControl(tab, ACTOR);
    expect(lease.lifetime).toBe("borrowed");
    expect(registry.listSessionTabs(1, ACTOR, false)).toHaveLength(1);
    await expect(registry.requestTabOp(1, { op: "close", tabId: tab.handle, actor: ACTOR }))
      .resolves.toEqual({ ok: true, tabId: tab.handle, retained: true });
    expect(registry.listTabs(1)).toHaveLength(1);
    expect(registry.listSessionTabs(1, ACTOR, false)).toEqual([]);
    expect(tab).toMatchObject({ owner: null, lease: null, controlMode: "human" });
    expect(ops).toEqual([]);
  });

  it("keeps borrowed pause after lease cleanup and requires a trusted Resume", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    const tab = registry.liveTab("tab-1")!;
    const lease = registry.acquireControl(tab, ACTOR);
    registry.userInput(71, { type: "mouseDown" });
    registry.releaseControl(tab.handle, lease.id);
    expect(() => registry.acquireControl(tab, ACTOR)).toThrow("paused");
    expect(registry.resume(1, "page")).toBe(true);
    expect(registry.acquireControl(tab, ACTOR).lifetime).toBe("borrowed");
  });

  it("keeps a human-only tab borrowable after native interaction and manual navigation", () => {
    const { registry } = setup();
    registry.stop(1, "page");
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    const tab = registry.liveTab("tab-1")!;
    const generation = tab.controlGeneration;
    registry.userInput(71, { type: "keyDown" });
    registry.stop(1, "page");
    registry.navigationStarted(71, "https://a.example/next");
    expect(tab.controlMode).toBe("human");
    expect(tab.controlGeneration).toBeGreaterThan(generation);
    expect(registry.resume(1, "page")).toBe(false);
    expect(registry.acquireControl(tab, ACTOR).lifetime).toBe("borrowed");
  });

  it("keeps an unattributed bootstrap human after a pre-bind Stop", async () => {
    const { registry, ops } = setup();
    const opening = registry.requestTabOp(1, { op: "new", url: "https://a.example/" });
    registry.stop(1, "page");
    attachTab(registry, { tabId: "page", webContentsId: 71, requestId: ops.at(-1)!.request.requestId }, 1, "about:blank");
    await expect(opening).resolves.toEqual({ ok: false, error: "aborted" });
    const tab = registry.liveTab("tab-1")!;
    expect(tab).toMatchObject({ controlMode: "human", owner: null });
    expect(registry.acquireControl(tab, ACTOR).lifetime).toBe("borrowed");
  });

  it("permits a creator and its actual direct parent or child, with nonrecursive child listing", async () => {
    const child = { sessionId: "child", directParentSessionId: "parent" };
    const { registry, tab } = await owned(child);
    expect(() => registry.assertActorAccess(tab, { sessionId: "parent" })).not.toThrow();
    expect(() => registry.assertActorAccess(tab, { sessionId: "child-of-child", directParentSessionId: "child" })).not.toThrow();
    for (const actor of [ACTOR, { sessionId: "grandparent" },
      { sessionId: "sibling", directParentSessionId: "parent" },
      { sessionId: "grandchild", directParentSessionId: "child-of-child" }]) {
      expect(() => registry.assertActorAccess(tab, actor)).toThrow("another conversation");
    }
    expect(registry.listSessionTabs(1, { sessionId: "parent" }, false)).toEqual([]);
    expect(registry.listSessionTabs(1, { sessionId: "parent" }, true).map((item) => item.tabId)).toEqual([tab.handle]);
    expect(registry.listSessionTabs(1, { sessionId: "grandparent" }, true)).toEqual([]);
    expect(registry.listSessionTabs(2, child, true)).toEqual([]);
    await expect(registry.requestTabOp(1, { op: "close", tabId: tab.handle, actor: ACTOR }))
      .resolves.toEqual({ ok: false, error: "not-authorized" });
    await expect(registry.requestTabOp(2, { op: "select", tabId: tab.handle, actor: child }))
      .resolves.toEqual({ ok: false, error: "no-such-tab" });
  });

  it("lets a direct child act on its parent's bound tab while retaining actual caller identity", async () => {
    const parent = { sessionId: "parent", directParentSessionId: "grandparent" };
    const child = { sessionId: "child", directParentSessionId: "parent" };
    const { registry, tab } = await owned(parent);
    registry.bindConversationSurface(parent.sessionId, { windowId: 1, surface: { kind: "browser", tabId: "page" } });
    expect(registry.defaultBrowserTab(1, child.directParentSessionId)).toEqual({ ok: true, handle: tab.handle });
    const generation = tab.controlGeneration;
    const lease = registry.acquireControl(tab, child);
    expect(lease).toMatchObject({ actor: child, lifetime: "owned" });
    expect(tab.owner).toEqual(parent);
    expect(tab.controlGeneration).toBe(generation);
    expect(parseBrowserTabControlState(registry.controlState(1))?.tabs[0]?.lease?.actor).toEqual(child);
    registry.releaseControl(tab.handle, lease.id);
    for (const actor of [
      { sessionId: "grandchild", directParentSessionId: "child" },
      { sessionId: "parent-sibling", directParentSessionId: "grandparent" },
      { sessionId: "unrelated" },
    ]) expect(() => registry.acquireControl(tab, actor)).toThrow("another conversation");
    expect(tab.owner).toEqual(parent);
    expect(tab.lease).toBeNull();
  });

  it("rejects concurrent leases and keeps caller identity copied across an await", async () => {
    const actor = { sessionId: "child", directParentSessionId: "parent" };
    const state = setup();
    const opening = state.registry.requestTabOp(1, { op: "new", url: "https://a.example/", actor });
    actor.sessionId = "unrelated";
    state.registry.guestAttached(new FakeGuest(71, "about:blank"), 1);
    state.registry.bindTab(1, { tabId: "page", webContentsId: 71, requestId: state.ops.at(-1)!.request.requestId });
    await opening;
    const tab = state.registry.liveTab("tab-1")!;
    expect(tab.owner).toEqual({ sessionId: "child", directParentSessionId: "parent" });
    state.registry.acquireControl(tab, { sessionId: "child", directParentSessionId: "parent" });
    expect(() => state.registry.acquireControl(tab, { sessionId: "child" })).toThrow("still controlling");
    expect(() => state.registry.acquireControl(tab, { sessionId: "parent" })).toThrow("controlled by another conversation");
  });

  it("publishes revisioned independent snapshots and opens agent tabs in the background by default", async () => {
    const { registry, tab, ops, control } = await owned();
    expect(ops[0]?.request).toMatchObject({ op: "new", active: false, url: "about:blank" });
    const first = registry.controlState(1);
    registry.pause(1, "page");
    expect(registry.controlState(1).revision).toBeGreaterThan(first.revision);
    expect(first.tabs[0]?.mode).toBe("agent-active");
    expect(control.at(-1)?.state).toEqual(registry.controlState(1));
    expect(parseBrowserTabControlState(registry.controlState(1))).toEqual(registry.controlState(1));
    expect(tab.owner).toEqual(ACTOR);
  });

  it("keeps blank-bind takeover strict while retaining known creation identity", async () => {
    const state = setup();
    const opening = state.registry.requestTabOp(1, { op: "new", url: "https://a.example/", actor: ACTOR, active: true });
    state.registry.stop(1, "page");
    state.registry.guestAttached(new FakeGuest(71, "about:blank"), 1);
    state.registry.bindTab(1, { tabId: "page", webContentsId: 71, requestId: state.ops.at(-1)!.request.requestId });
    await expect(opening).resolves.toEqual({ ok: false, error: "aborted" });
    expect(state.registry.liveTab("tab-1")).toMatchObject({ owner: ACTOR, controlMode: "human-paused", agentOrigin: null, opener: "user" });
    expect(state.ops[0]?.request).toMatchObject({ active: true });
    expect(state.registry.resume(1, "page")).toBe(true);
  });

  it("invalidates action generations before navigation and document replacement", async () => {
    const { registry, tab } = await owned();
    const lease = registry.acquireControl(tab, ACTOR);
    const first = tab.actions.signal;
    const firstGeneration = tab.controlGeneration;
    registry.navigationStarted(71, "https://a.example/next");
    expect(first.aborted).toBe(true);
    expect(first.reason).toBeInstanceOf(BrowserDocumentChangedError);
    expect(first.reason.code).toBe("browser-document-changed");
    expect(tab.controlGeneration).toBeGreaterThan(firstGeneration);
    const next = tab.actions.signal;
    registry.documentChanged(71);
    expect(next.aborted).toBe(true);
    expect(next.reason).toBeInstanceOf(BrowserDocumentChangedError);
    expect(tab.lease).toBe(lease);
  });

  it.each(["human-input", "stop", "pause", "release", "closed", "origin-change"])("keeps %s cancellation distinct from document transition", async (kind) => {
    const { registry, tab, guest } = await owned();
    const lease = registry.acquireControl(tab, ACTOR);
    const signal = tab.actions.signal;
    if (kind === "human-input") registry.userInput(71, { type: "keyDown" });
    if (kind === "stop") registry.stop(1, "page");
    if (kind === "pause") registry.pause(1, "page");
    if (kind === "release") registry.releaseControl(tab.handle, lease.id);
    if (kind === "closed") registry.guestDestroyed(71);
    if (kind === "origin-change") {
      guest.url = "https://b.example/";
      registry.liveTab(tab.handle);
    }
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect(signal.reason).not.toBeInstanceOf(BrowserDocumentChangedError);
    expect(signal.reason).not.toHaveProperty("code", "browser-document-changed");
    const reason = signal.reason;
    registry.documentChanged(71);
    registry.navigationStarted(71, "https://a.example/next");
    expect(signal.reason).toBe(reason);
  });

  it("releases window resources without closing another window's tabs", async () => {
    const { registry, tab } = await owned();
    attachTab(registry, { tabId: "other", webContentsId: 72 }, 2);
    registry.acquireControl(tab, ACTOR);
    const signal = tab.actions.signal;
    registry.releaseWindow(1);
    expect(signal.aborted).toBe(true);
    expect(registry.listTabs(1)).toEqual([]);
    expect(registry.liveRendererTab(1, "page")).toBeNull();
    expect(registry.listTabs(2)).toHaveLength(1);
  });

  it("focuses only the bound active renderer slot and waits for actual guest focus", async () => {
    vi.useFakeTimers();
    const { registry, tab, guest, ops } = await owned();
    registry.setActiveSurface(1, { kind: "browser", tabId: "page" });
    registry.acquireControl(tab, ACTOR);
    const focused = registry.focusGuest(71);
    const settled = vi.fn(); void focused.then(settled);
    expect(ops.at(-1)?.request).toMatchObject({ op: "focus", tabId: "page" });
    await vi.advanceTimersByTimeAsync(40);
    expect(settled).not.toHaveBeenCalled();
    guest.focused = true;
    await vi.advanceTimersByTimeAsync(20);
    await expect(focused).resolves.toBeUndefined();
    await expect(registry.focusGuest(404)).rejects.toThrow("no live browser focus target");
  });

  it("rejects hidden, inactive or uncontrolled focus targets before sending a renderer request", async () => {
    const { registry, tab, ops } = await owned();
    const count = ops.length;
    await expect(registry.focusGuest(71)).rejects.toThrow("requires active control");
    registry.acquireControl(tab, ACTOR);
    await expect(registry.focusGuest(71)).rejects.toThrow("not the active visible surface");
    registry.setActiveSurface(1, { kind: "browser", tabId: "page" });
    registry.setRendererLink({ sendTabOp: () => true, sendControl: () => undefined, isWindowVisible: () => false });
    await expect(registry.focusGuest(71)).rejects.toThrow("hidden or unavailable");
    expect(ops).toHaveLength(count);
  });

  it("rejects missing native focus proof rather than reporting a renderer send as success", async () => {
    const registry = new BrowserTabRegistry<BrowserGuest>();
    registry.guestAttached({ id: 71, getURL: () => "https://site.example/", getTitle: () => "Site", isDestroyed: () => false }, 1);
    registry.bindTab(1, { tabId: "page", webContentsId: 71 });
    await expect(registry.focusGuest(71)).rejects.toThrow("native browser focus proof is unavailable");
  });

  it("bounds native focus waiting and preserves cancellation priority over late focus", async () => {
    vi.useFakeTimers();
    const { registry, tab, guest } = await owned();
    registry.setActiveSurface(1, { kind: "browser", tabId: "page" });
    const first = registry.acquireControl(tab, ACTOR);
    const timeout = registry.focusGuest(71).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timeout).resolves.toContain("timed out");
    registry.releaseControl(tab.handle, first.id);
    const second = registry.acquireControl(tab, ACTOR);
    const pending = registry.focusGuest(71).catch((error: Error) => error.message);
    registry.releaseControl(tab.handle, second.id);
    guest.focused = true;
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toContain("released");
  });
});

describe("native popup lifecycle", () => {
  function popup() {
    const state = setup();
    state.registry.guestAttached(new FakeGuest(71), 1);
    state.registry.bindTab(1, { tabId: "page", webContentsId: 71 });
    const guest = new FakeGuest(72, "https://b.example/", "Popup");
    const native = { select: vi.fn(() => true), close: vi.fn() };
    const handle = state.registry.registerPopup(71, guest, native)!;
    return { ...state, guest, native, handle };
  }

  it("registers a same-window popup without a renderer slot or inherited origin approval", () => {
    const { registry, handle } = popup();
    expect(registry.liveTab(handle)).toMatchObject({ windowId: 1, rendererTabId: null, targetKind: "popup", openerTabId: "tab-1", opener: "user", agentOrigin: null });
    expect(registry.listTabs(1)[1]).toMatchObject({ kind: "popup", rendererTabId: null, openerTabId: "tab-1" });
    expect(parseBrowserTabControlState(registry.controlState(1))).not.toBeNull();
    expect(registry.registerPopup(404, new FakeGuest(73), { select: () => true, close() {} })).toBeNull();
    registry.guestAttached(new FakeGuest(74), 2);
    expect(registry.registerPopup(71, new FakeGuest(74), { select: () => true, close() {} })).toBeNull();
    expect(registry.registerPopup(71, registry.liveTab(handle)!.guest!, { select: () => true, close() {} })).toBeNull();
  });

  it("selects through native focus confirmation and closes only after observed destruction", async () => {
    const { registry, handle, native, ops } = popup();
    await expect(registry.requestTabOp(1, { op: "select", tabId: handle, actor: ACTOR })).resolves.toEqual({ ok: true, tabId: handle });
    expect(registry.activeBrowserTab(1)).toBe(handle);
    const closed = registry.requestTabOp(1, { op: "close", tabId: handle });
    const settled = vi.fn();
    void closed.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
    expect(ops).toEqual([]);
    registry.guestDestroyed(72);
    await expect(closed).resolves.toEqual({ ok: true, tabId: handle });
    expect(registry.activeBrowserTab(1)).toBeUndefined();
  });

  it("fails selection when native focus is unconfirmed and retains a borrowed popup on agent close", async () => {
    const { registry, handle, native } = popup();
    native.select.mockReturnValue(false);
    await expect(registry.requestTabOp(1, { op: "select", tabId: handle, actor: ACTOR })).resolves.toEqual({ ok: false, error: "native-operation-failed" });
    await expect(registry.requestTabOp(1, { op: "close", tabId: handle, actor: ACTOR })).resolves.toEqual({ ok: true, tabId: handle, retained: true });
    expect(native.close).not.toHaveBeenCalled();
    expect(registry.liveTab(handle)).toBeDefined();
  });

  it("resumes a paused popup only through its explicit same-window handle API", () => {
    const { registry, handle } = popup();
    const tab = registry.liveTab(handle)!;
    const lease = registry.acquireControl(tab, ACTOR);
    registry.userInput(72, { type: "keyDown" });
    registry.releaseControl(handle, lease.id);
    expect(registry.resume(1, handle)).toBe(false);
    expect(registry.resumePopup(2, handle)).toBe(false);
    expect(registry.resumePopup(1, "tab-1")).toBe(false);
    expect(registry.resumePopup(1, handle)).toBe(true);
    expect(registry.acquireControl(tab, ACTOR).lifetime).toBe("borrowed");
    expect(registry.pausePopup(1, handle)).toBe(true);
    expect(tab.controlMode).toBe("human-paused");
  });

  it("waits for native focus confirmation and discards it after cancellation", async () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    const { promise: focused, resolve: resolveNativeFocus } = deferred<boolean>();
    const handle = registry.registerPopup(71, new FakeGuest(72), { select: () => focused, close() {} })!;
    const abort = new AbortController();
    const selecting = registry.requestTabOp(1, { op: "select", tabId: handle, actor: ACTOR }, { signal: abort.signal });
    expect(registry.activeBrowserTab(1)).toBeUndefined();
    abort.abort();
    resolveNativeFocus(true);
    await expect(selecting).resolves.toEqual({ ok: false, error: "aborted" });
    await Promise.resolve();
    expect(registry.activeBrowserTab(1)).toBeUndefined();
  });

  it("attributes a new popup to the active caller without granting origin provenance", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    registry.acquireControl(registry.liveTab("tab-1")!, ACTOR);
    const handle = registry.registerPopup(71, new FakeGuest(72, "https://b.example/"), { select: () => true, close() {} })!;
    expect(registry.liveTab(handle)).toMatchObject({ owner: ACTOR, opener: "user", agentOrigin: null });
    expect(registry.listSessionTabs(1, ACTOR, false).map((tab) => tab.tabId)).toContain(handle);
    expect(registry.bindTab(1, { tabId: "stolen", webContentsId: 72 })).toEqual({ ok: false, error: "guest-not-hosted" });
  });

  it("focuses a leased popup only after its native selection and actual guest focus proof", async () => {
    const { registry, handle, native, guest } = popup();
    registry.acquireControl(registry.liveTab(handle)!, ACTOR);
    native.select.mockImplementation(() => { guest.focused = true; return true; });
    await expect(registry.focusGuest(guest.id)).resolves.toBeUndefined();
    expect(native.select).toHaveBeenCalledOnce();
    expect(registry.activeBrowserTab(1)).toBe(handle);
  });
});

describe("strict browser chrome contracts", () => {
  it("rejects missing presentation intent and malformed hosting identity", () => {
    expect(parseBrowserTabOpRequest({ requestId: "r", op: "new", url: "about:blank" })).toBeNull();
    expect(parseBrowserTabOpRequest({ requestId: "r", op: "new", url: "about:blank", active: false, sessionId: 7 })).toBeNull();
    expect(parseBrowserTabOpRequest({ requestId: "r", op: "new", url: "about:blank", active: false }))
      .toEqual({ requestId: "r", op: "new", url: "about:blank", active: false });
    expect(parseBrowserTabOpRequest({ requestId: "r", op: "focus", tabId: "page" }))
      .toEqual({ requestId: "r", op: "focus", tabId: "page" });
    expect(parseBrowserTabOpRequest({ requestId: "r", op: "focus", tabId: "" })).toBeNull();
    expect(parseBrowserTabOpRequest({ requestId: "r", op: "focus", tabId: "page", webContentsId: 71 })).toBeNull();
  });

  it("rejects mixed-version state, extra fields, duplicate handles, impossible leases and malformed actors", () => {
    expect(parseBrowserTabControlState({ agentControlledTabIds: [] })).toBeNull();
    const tab = {
      tabId: "tab-1", rendererTabId: "page", url: "about:blank", title: "Page", mode: "agent-active",
      owner: ACTOR, lease: null, generation: 1, kind: "embedded", openerTabId: null,
    };
    const state = { revision: 1, tabs: [tab] };
    expect(parseBrowserTabControlState(state)).toEqual(state);
    for (const candidate of [
      { ...state, revision: -1 }, { ...state, unexpected: true }, { ...state, tabs: [tab, tab] },
      { ...state, tabs: [{ ...tab, generation: 0.5 }] }, { ...state, tabs: [{ ...tab, rendererTabId: null }] },
      { ...state, tabs: [{ ...tab, owner: { sessionId: "a", directParentSessionId: "a" } }] },
      { ...state, tabs: [{ ...tab, lease: { id: "l", actor: ACTOR, lifetime: "borrowed" } }] },
      { ...state, tabs: [{ ...tab, mode: "human", lease: { id: "l", actor: ACTOR, lifetime: "owned" } }] },
      { ...state, tabs: [{ ...tab, lease: { id: "l", actor: { sessionId: "grandchild", directParentSessionId: "child" }, lifetime: "owned" } }] },
      { ...state, tabs: [{ ...tab, owner: { sessionId: "child", directParentSessionId: "parent" },
        lease: { id: "l", actor: { sessionId: "sibling", directParentSessionId: "parent" }, lifetime: "owned" } }] },
    ]) expect(parseBrowserTabControlState(candidate)).toBeNull();
  });
});

describe("native injected mouse attribution", () => {
  it("matches only armed exact raw press/release and reports another same-window recipient", () => {
    const { registry } = setup();
    for (const [guestId, windowId] of [[71, 1], [72, 1], [73, 2]]) {
      registry.guestAttached(new FakeGuest(guestId!), windowId!);
      registry.bindTab(windowId!, { tabId: `page-${guestId}`, webContentsId: guestId! });
    }
    const signal = registry.liveTab("tab-1")!.actions.signal;
    const watch = registry.watchMouse(71);
    registry.armMouse(71, { type: "mouseDown", x: 93, y: 197, button: "left", clickCount: 1 });
    registry.userInput(71, { type: "mouseDown", x: 93, y: 197, button: "left", clickCount: 1 });
    registry.armMouse(71, { type: "mouseUp", x: 203, y: 197, button: "left", clickCount: 1 });
    registry.userInput(71, { type: "mouseUp", x: 203, y: 197, button: "left", clickCount: 1 });
    expect(signal.aborted).toBe(false);
    registry.userInput(72, { type: "mouseDown", x: 93, y: 197, button: "left", clickCount: 1 });
    registry.userInput(73, { type: "mouseDown", x: 93, y: 197, button: "left", clickCount: 1 });
    expect(watch.delivery()).toEqual({ pressed: true, released: true, elsewhere: 1 });
    watch.stop();
    registry.userInput(71, { type: "mouseDown", _modifiers: 1 << 23 });
    expect(signal.aborted).toBe(true);
  });

  it("never hides an extra human press during an armed drag", () => {
    const { registry } = setup();
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    const tab = registry.liveTab("tab-1")!;
    registry.acquireControl(tab, ACTOR);
    const watch = registry.watchMouse(71);
    registry.armMouse(71, { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 });
    registry.userInput(71, { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 });
    registry.userInput(71, { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 });
    expect(tab.controlMode).toBe("human-paused");
    expect(tab.actions.signal.aborted).toBe(true);
    watch.stop();
  });

  it.each(["position", "button", "click-count", "order", "modifier", "unarmed", "expired"])("rejects %s mouse receipts and revokes further expectations", (kind) => {
    vi.useFakeTimers();
    const { registry } = setup();
    attachTab(registry, { tabId: "page", webContentsId: 71 });
    const tab = registry.liveTab("tab-1")!;
    registry.acquireControl(tab, ACTOR);
    const watch = registry.watchMouse(71);
    const expected = { type: "mouseDown" as const, x: 10, y: 20, button: "left" as const, clickCount: 1 as const };
    if (kind !== "unarmed") registry.armMouse(71, expected);
    if (kind === "expired") vi.advanceTimersByTime(1_001);
    registry.userInput(71, {
      ...expected, ...(kind === "position" ? { x: 11 } : {}), ...(kind === "button" ? { button: "right" } : {}),
      ...(kind === "click-count" ? { clickCount: 2 } : {}), ...(kind === "order" ? { type: "mouseUp" } : {}),
      ...(kind === "modifier" ? { _modifiers: 2 } : {}),
    });
    expect(tab.controlMode).toBe("human-paused");
    expect(watch.delivery().pressed).toBe(false);
    expect(() => registry.armMouse(71, expected)).toThrow("no available");
    watch.stop();
  });

  it("allows only one bounded native pointer watch per window and enforces press order", () => {
    const { registry } = setup();
    for (const [guestId, windowId] of [[71, 1], [72, 1], [73, 2]]) registry.guestAttached(new FakeGuest(guestId!), windowId!);
    const watch = registry.watchMouse(71);
    expect(() => registry.watchMouse(72)).toThrow("active in this window");
    expect(() => registry.watchWheel(72)).toThrow("active in this window");
    const otherWindow = registry.watchWheel(73);
    expect(() => registry.armMouse(71, { type: "mouseUp", x: 10, y: 20, button: "left", clickCount: 1 })).toThrow("invalid native mouse dispatch sequence");
    watch.stop(); otherWindow.stop();
    expect(() => registry.watchMouse(404)).toThrow("no live native pointer recipient");
  });
});

describe("native injected wheel attribution", () => {
  function page() {
    const state = setup();
    state.registry.guestAttached(new FakeGuest(71), 1);
    state.registry.bindTab(1, { tabId: "page", webContentsId: 71 });
    const tab = state.registry.liveTab("tab-1")!;
    state.registry.acquireControl(tab, ACTOR);
    return { ...state, tab };
  }
  const MARK = 1 << 23;

  it("matches the observed marked wheel, derived begin/update, second marked wheel and derived end", () => {
    const { registry, tab } = page();
    const watch = registry.watchWheel(71);
    for (const [type, modifiers] of [
      ["mouseWheel", MARK], ["gestureScrollBegin", 0], ["gestureScrollUpdate", 0], ["mouseWheel", MARK], ["gestureScrollEnd", 0],
    ] as const) registry.userInput(71, { type, _modifiers: modifiers });
    expect(watch.delivery()).toEqual({ started: true, ended: true, elsewhere: 0 });
    expect(tab.actions.signal.aborted).toBe(false);
    watch.stop();
    registry.userInput(71, { type: "gestureScrollEnd", _modifiers: 0 });
    expect(tab.controlMode).toBe("human-paused");
  });

  it.each(["no-source", "out-of-order", "extra-update", "human-wheel", "key", "modified-gesture", "expired"])("never attributes %s to an injected wheel", (kind) => {
    vi.useFakeTimers();
    const { registry, tab } = page();
    const watch = registry.watchWheel(71);
    if (kind !== "no-source") registry.userInput(71, { type: "mouseWheel", _modifiers: MARK });
    if (kind === "expired") vi.advanceTimersByTime(5_001);
    if (kind === "extra-update") {
      registry.userInput(71, { type: "gestureScrollBegin", _modifiers: 0 });
      registry.userInput(71, { type: "gestureScrollUpdate", _modifiers: 0 });
    }
    const type = kind === "human-wheel" ? "mouseWheel" : kind === "key" ? "keyDown"
      : kind === "out-of-order" || kind === "extra-update" ? "gestureScrollUpdate" : "gestureScrollBegin";
    registry.userInput(71, { type, _modifiers: kind === "modified-gesture" ? 2 : 0 });
    expect(tab.controlMode).toBe("human-paused");
    registry.userInput(71, { type: "gestureScrollEnd", _modifiers: 0 });
    expect(watch.delivery().ended).toBe(false);
    watch.stop();
  });

  it("reports wheel input delivered to another guest in the same window", () => {
    const { registry } = page();
    attachTab(registry, { tabId: "other", webContentsId: 72 });
    attachTab(registry, { tabId: "elsewhere", webContentsId: 73 }, 2);
    const watch = registry.watchWheel(71);
    registry.userInput(72, { type: "mouseWheel", _modifiers: MARK });
    registry.userInput(73, { type: "mouseWheel", _modifiers: MARK });
    expect(watch.delivery()).toEqual({ started: false, ended: false, elsewhere: 1 });
    watch.stop();
  });
});
