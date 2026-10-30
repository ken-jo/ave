import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";

type Listener = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  let nextId = 1;
  class FakeBrowserWindow {
    private readonly windowId = nextId++;
    get id() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      return this.windowId;
    }
    readonly listeners = new Map<string, Listener[]>();
    readonly contentsListeners = new Map<string, Listener[]>();
    destroyed = false;
    visible = true;
    readonly hide = vi.fn(() => { this.visible = false; });
    readonly show = vi.fn(() => { this.visible = true; });
    readonly focus = vi.fn();
    readonly moveTop = vi.fn();
    readonly restore = vi.fn();
    readonly loadFile = vi.fn(async () => undefined);
    readonly loadURL = vi.fn(async () => undefined);
    private readonly contents = {
      id: this.id * 100,
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      on: (name: string, fn: Listener) => this.pushContents(name, fn),
      once: (name: string, fn: Listener) => this.pushContents(name, fn),
      send: vi.fn(),
    };
    get webContents() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      return this.contents;
    }
    constructor(readonly options: unknown) {}
    private pushContents(name: string, fn: Listener) {
      this.contentsListeners.set(name, [...(this.contentsListeners.get(name) ?? []), fn]);
    }
    on(name: string, fn: Listener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
      return this;
    }
    once(name: string, fn: Listener) {
      return this.on(name, fn);
    }
    emit(name: string, ...args: unknown[]) {
      for (const fn of this.listeners.get(name) ?? []) fn(...args);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    isAlwaysOnTop() { return false; }
    // What Electron does when nothing prevented `close`.
    close() {
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      if (prevented) return false;
      this.destroyed = true;
      this.emit("closed");
      return true;
    }
  }
  return { FakeBrowserWindow, app: { name: "Ave", getPath: vi.fn(() => "/tmp/ave-test"), quit: vi.fn() } };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.FakeBrowserWindow,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  shell: { openExternal: vi.fn(async () => undefined) },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  nativeImage: {},
  Tray: class {},
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));
vi.mock("../native-window-coordinator.js", () => ({ requestNativeChromeRefresh: vi.fn() }));
const killTerminalsOwnedBy = vi.fn((_ownerWindowId: number) => 0);
vi.mock("../terminal/pty-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/pty-manager.js")>()),
  killTerminalsOwnedBy: (ownerWindowId: number) => killTerminalsOwnedBy(ownerWindowId),
  terminalOwnerWindowId: (tabId: string) => terminalOwners.get(tabId),
}));
const terminalOwners = new Map<string, number | null>();

const appState = await import("../app-state.js");
const approvalSurfaces = await import("../../permissions/approval-surface-registry.js");
const { createWindow, getAppWindows, loadMainInterface, rendererIndexUrl } = await import("../main-window.js");
const { openNewMainWindow, showOrCreatePrimaryMainWindow } = await import("../app-tray.js");
const { promptSurfaceResolver } = await import("../../boot/host-runtime.js");
type FakeWindow = InstanceType<typeof electronMock.FakeBrowserWindow>;

function open(): FakeWindow {
  return createWindow({ showBootstrapSplash: false }) as unknown as FakeWindow;
}

describe("main windows", () => {
  beforeEach(() => {
    appState.resetMainWindowsForTests();
    appState.setTray({ setContextMenu: vi.fn() } as never);
    appState.setServices(null);
    electronMock.app.quit.mockClear();
  });

  it("opens a centered responsive window with theme-only boot arguments", () => {
    const win = open();
    expect(win.options).toMatchObject({
      x: 339, y: 156, width: 1243, height: 768, minWidth: 360,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const options = win.options as { webPreferences: { additionalArguments: string[] } };
    expect(options.webPreferences.additionalArguments.every((arg) => arg.startsWith("--ave-initial-theme="))).toBe(true);
  });

  it("gives the first window the primary role and every later one the secondary role", () => {
    const first = open();
    const second = open();
    expect(appState.getPrimaryMainWindow()).toBe(first);
    expect(appState.isSecondaryMainWindowContents(second.webContents)).toBe(true);
    expect(appState.isSecondaryMainWindowContents(first.webContents)).toBe(false);
    // Broadcasts reach both; point-to-point sends follow focus.
    expect(getAppWindows()).toEqual([first, second]);
    expect(appState.getMainWindow()).toBe(second);
    first.emit("focus");
    expect(appState.getMainWindow()).toBe(first);
  });

  it("closes a window for real while another is open, and hides only the last one to the tray", () => {
    const first = open();
    const second = open();

    expect(first.close()).toBe(true);
    expect(first.hide).not.toHaveBeenCalled();
    expect(getAppWindows()).toEqual([second]);
    // The primary role is free; the window still open keeps its own role.
    expect(appState.getPrimaryMainWindow()).toBeNull();
    expect(appState.isSecondaryMainWindowContents(second.webContents)).toBe(true);

    expect(second.close()).toBe(false);
    expect(second.hide).toHaveBeenCalledOnce();
    expect(getAppWindows()).toEqual([second]);

    const third = open();
    expect(appState.getPrimaryMainWindow()).toBe(third);
  });

  it("closes the terminals of a window that closes for real, and only that window's", () => {
    killTerminalsOwnedBy.mockClear();
    const first = open();
    const firstId = first.id;
    const second = open();
    expect(first.close()).toBe(true);
    expect(killTerminalsOwnedBy.mock.calls).toEqual([[firstId]]);
    // The last window hides to the tray: it is not gone, nor are its shells.
    expect(second.close()).toBe(false);
    expect(killTerminalsOwnedBy.mock.calls).toEqual([[firstId]]);
  });

  it("releases the captured owner and restores focus when destroyed windows emit closed", () => {
    appState.setTray(null);
    const first = open();
    const second = open();
    const third = open();
    const secondId = second.id;
    const firstSurface = first.webContents;
    const secondSurface = second.webContents;
    const update = vi.spyOn(approvalSurfaces, "updateApprovalSurface");
    try {
      approvalSurfaces.updateApprovalSurface({ kind: "attach", sessionId: "closing-owner", surface: secondSurface as never });
      approvalSurfaces.updateApprovalSurface({ kind: "attach", sessionId: "remaining-owner", surface: firstSurface as never });
      first.emit("focus");
      second.emit("focus");
      second.destroyed = true;
      expect(() => second.webContents).toThrow(TypeError);
      expect(() => second.id).toThrow(TypeError);
      expect(() => second.emit("closed")).not.toThrow();
      expect(update).toHaveBeenCalledWith({ kind: "release-owner", surface: secondSurface });
      expect(killTerminalsOwnedBy).toHaveBeenCalledWith(secondId);
      expect(getAppWindows()).toEqual([first, third]);
      expect(appState.getMainWindow()).toBe(first);
      expect(appState.getPrimaryMainWindow()).toBe(first);
      // Prove revocation independently of the surface's destroyed check.
      second.destroyed = false;
      expect(approvalSurfaces.approvalSurfaceRegistry.resolve("closing-owner")).toBeNull();
      expect(approvalSurfaces.approvalSurfaceRegistry.resolve("remaining-owner")).toBe(firstSurface);
      second.destroyed = true;
      second.emit("focus");
      expect(appState.getMainWindow()).toBe(first);
      expect(first.close()).toBe(true);
      expect(appState.getPrimaryMainWindow()).toBeNull();
      expect(appState.getMainWindow()).toBe(third);
      expect(third.close()).toBe(true);
      expect(appState.getMainWindow()).toBeNull();
      expect(open()).toBe(appState.getPrimaryMainWindow());
    } finally {
      update.mockRestore();
      approvalSurfaces.updateApprovalSurface({ kind: "release", sessionId: "closing-owner" });
      approvalSurfaces.updateApprovalSurface({ kind: "release", sessionId: "remaining-owner" });
    }
  });

  it("never reloads or re-roles the other windows when the primary closes", async () => {
    appState.setRendererReloadReady(true);
    try {
      const first = open();
      const second = open();
      const third = open();
      second.emit("focus");
      for (const win of [second, third]) { win.loadFile.mockClear(); win.loadURL.mockClear(); }

      expect(first.close()).toBe(true);
      await Promise.resolve();
      for (const win of [second, third]) {
        expect(win.loadFile).not.toHaveBeenCalled();
        expect(win.loadURL).not.toHaveBeenCalled();
        expect(appState.isSecondaryMainWindowContents(win.webContents)).toBe(true);
      }
      // Focus falls back to the window the user was in before.
      expect(appState.getMainWindow()).toBe(second);
    } finally {
      appState.setRendererReloadReady(false);
    }
  });

  it("with every main window closed, the next window opened claims the primary role", () => {
    appState.setTray(null);
    const first = open();
    expect(first.close()).toBe(true);
    expect(appState.getPrimaryMainWindow()).toBeNull();
    const next = open();
    expect(appState.getPrimaryMainWindow()).toBe(next);
  });

  function promptSurface() {
    return promptSurfaceResolver(
      {
        desktop: {
          findSessionSurface: appState.findSessionMainWindowContents,
          findTerminalSurface: appState.findTerminalMainWindowContents,
        } as never,
      },
      appState.getMainWindow,
    );
  }

  it("draws a terminal tab's egress ask in the window that owns the tab, never in the focused one", async () => {
    const { ApprovalGate } = await import("../../permissions/approval-gate.js");
    const first = open();
    const second = open();
    first.emit("focus");
    terminalOwners.set("terminal:0a1b2c3d-1", second.id);
    const gate = new ApprovalGate(promptSurface());
    const egressAsk = (id: string, tabId: string): ApprovalRequestInput => ({
      id,
      category: "tool" as const,
      kind: "egress-host" as const,
      toolName: "terminal",
      args: { host: "github.com", port: 443, tabId },
      reason: "terminal egress",
      createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      forceExplicit: true,
      egressHost: { host: "github.com", port: 443, rule: "Network(github.com:443)", scopes: ["once", "tab"], network: "public", terminalTabId: tabId },
    });
    try {
      const owned = gate.requestAndWait(egressAsk("egress-owned", "terminal:0a1b2c3d-1"));
      expect(second.webContents.send).toHaveBeenCalledWith("ave:approval:request", expect.objectContaining({ id: "egress-owned" }));
      expect(first.webContents.send).not.toHaveBeenCalledWith("ave:approval:request", expect.anything());
      // A reloaded window refetching pending asks gets only its own tabs'; an answer from the other window is ignored and the ask stays pending.
      expect(gate.listPendingRendererRequests(first.webContents as never).map((r) => r.id)).toEqual([]);
      const [card] = gate.listPendingRendererRequests(second.webContents as never);
      expect(card?.id).toBe("egress-owned");
      const decision = { requestId: "egress-owned", choice: "allow-once" as const, egressScope: "once" as const, nonce: card!.nonce, hmac: card!.hmac };
      expect(gate.resolveFromDesktopRenderer("egress-owned", decision, first.webContents as never)).toBeNull();
      expect(gate.listPendingRendererRequests(second.webContents as never).map((r) => r.id)).toEqual(["egress-owned"]);
      // A tab no live window owns is denied, not shown somewhere else.
      const orphan = await gate.requestAndWait(egressAsk("egress-orphan", "terminal:0a1b2c3d-9"));
      expect(orphan.choice).toBe("deny-once");
      expect(first.webContents.send).not.toHaveBeenCalledWith("ave:approval:request", expect.objectContaining({ id: "egress-orphan" }));
      expect(second.webContents.send).not.toHaveBeenCalledWith("ave:approval:request", expect.objectContaining({ id: "egress-orphan" }));
      gate.disposeAll();
      await owned.catch(() => undefined);
    } finally {
      terminalOwners.clear();
    }
  });

  it("still delivers approvals after the first window closes while a second stays open", async () => {
    const { ApprovalGate } = await import("../../permissions/approval-gate.js");
    const first = open();
    const second = open();
    // Bound to nothing at construction: the first window closing must not strand it.
    const gate = new ApprovalGate(promptSurface());
    const firstSurface = first.webContents;

    expect(first.close()).toBe(true);
    const request = {
      id: "req-after-close",
      category: "tool" as const,
      toolName: "agent_spawn",
      args: { title: "t", instructions: "x" },
      reason: "state change",
      source: "builtin" as const,
      sessionId: "session-a",
      createdAt: Date.now(),
    };
    const decision = gate.requestAndWait(request as never);
    expect(second.webContents.send).toHaveBeenCalledWith(
      "ave:approval:request",
      expect.objectContaining({ id: "req-after-close" }),
    );
    expect(firstSurface.send).not.toHaveBeenCalledWith("ave:approval:request", expect.anything());
    gate.disposeAll();
    await decision.catch(() => undefined);
  });

  it("sends an ask-user question to the window showing the session, not the focused one", async () => {
    const { AskUserQuestionGate } = await import("../ask-user-question-gate.js");
    const first = open();
    const second = open();
    first.emit("focus");
    appState.setSessionContentsLookup((sessionId) =>
      sessionId === "session-b" ? (second.webContents as never) : null);
    const gate = new AskUserQuestionGate(promptSurface(), 60_000);

    void gate.ask({ questions: [{ question: "which?", choices: ["a", "b"] }] as never, sessionId: "session-b" });
    expect(second.webContents.send).toHaveBeenCalledWith(
      "ave:ask-user-question:request",
      expect.objectContaining({ sessionId: "session-b" }),
    );
    expect(first.webContents.send).not.toHaveBeenCalled();

    // A session no window shows goes to the window in use.
    second.webContents.send.mockClear();
    void gate.ask({ questions: [{ question: "other?", choices: ["a", "b"] }] as never, sessionId: "session-z" });
    expect(first.webContents.send).toHaveBeenCalledWith(
      "ave:ask-user-question:request",
      expect.objectContaining({ sessionId: "session-z" }),
    );
    expect(second.webContents.send).not.toHaveBeenCalled();

    // Both stay listed for a renderer that loads later (a window opened after the one that drew them closed).
    expect(gate.listPending().map((req) => req.sessionId)).toEqual(["session-b", "session-z"]);
    gate.disposeAll();
    expect(gate.listPending()).toEqual([]);
  });

  it("quits from the last window only when the close preference says quit", () => {
    appState.setServices({
      settingsService: { getAll: () => ({ system: { closeBehavior: "quit" } }) },
    } as never);
    const first = open();
    const second = open();
    expect(second.close()).toBe(true);
    expect(electronMock.app.quit).not.toHaveBeenCalled();
    expect(first.close()).toBe(false);
    expect(electronMock.app.quit).toHaveBeenCalledOnce();
  });

  it("an explicit New Window opens another window beside a visible one but brings back a hidden-only app", () => {
    appState.setRendererReloadReady(true);
    try {
      const first = open();
      openNewMainWindow("tray-new-window");
      expect(getAppWindows()).toHaveLength(2);

      // Close the second (destroyed) and the first to the tray (hidden).
      expect((getAppWindows()[1] as unknown as FakeWindow).close()).toBe(true);
      expect(first.close()).toBe(false);
      expect(first.isVisible()).toBe(false);

      openNewMainWindow("tray-new-window");
      expect(getAppWindows()).toEqual([first]);
      expect(first.isVisible()).toBe(true);
    } finally {
      appState.setRendererReloadReady(false);
    }
  });

  it("a relaunch brings the primary window back instead of opening another", () => {
    appState.setRendererReloadReady(true);
    try {
      const first = open();
      const second = open();
      // The secondary window is the one in use; a relaunch still surfaces the primary.
      expect(appState.getMainWindow()).toBe(second);
      for (const win of [first, second]) { win.show.mockClear(); win.focus.mockClear(); }
      for (let i = 0; i < 5; i += 1) showOrCreatePrimaryMainWindow("second-instance");
      expect(getAppWindows()).toEqual([first, second]);
      expect(first.show).toHaveBeenCalled();
      expect(first.focus).toHaveBeenCalled();
      expect(second.focus).not.toHaveBeenCalled();

      // Hidden to the tray, the primary is restored rather than replaced.
      expect(second.close()).toBe(true);
      expect(first.close()).toBe(false);
      showOrCreatePrimaryMainWindow("second-instance");
      expect(getAppWindows()).toEqual([first]);
      expect(first.isVisible()).toBe(true);
    } finally {
      appState.setRendererReloadReady(false);
    }
  });

  it("a relaunch after the primary closed opens one fresh primary beside the secondary, once", () => {
    appState.setRendererReloadReady(true);
    try {
      const first = open();
      const second = open();
      expect(first.close()).toBe(true);
      for (let i = 0; i < 3; i += 1) showOrCreatePrimaryMainWindow("second-instance");
      const windows = getAppWindows();
      expect(windows).toHaveLength(2);
      expect(windows[0]).toBe(second);
      expect(appState.getPrimaryMainWindow()).toBe(windows[1]);
      // The fresh primary loads the bare document: it resumes the primary conversation.
      expect((windows[1] as unknown as FakeWindow).loadFile).toHaveBeenCalled();
      expect(((windows[1] as unknown as FakeWindow).loadFile.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toBeUndefined();
    } finally {
      appState.setRendererReloadReady(false);
    }
  });

  it("loads a secondary window's document with the role query and the primary's bare", async () => {
    const first = open();
    const second = open();
    await loadMainInterface(first as never, "test");
    await loadMainInterface(second as never, "test");
    expect(first.loadFile).toHaveBeenCalledWith(expect.stringMatching(/index\.html$/), undefined);
    expect(second.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/index\.html$/),
      { query: { aveWindow: "secondary" } },
    );
  });

  it("lets a main window navigate only to the app document", () => {
    const win = open();
    const willNavigate = win.contentsListeners.get("will-navigate")![0]!;
    const navigate = (url: string) => {
      const event = { url, preventDefault: vi.fn() };
      willNavigate(event);
      return event.preventDefault.mock.calls.length === 0;
    };
    expect(navigate(rendererIndexUrl())).toBe(true);
    expect(navigate(`${rendererIndexUrl()}?aveWindow=secondary`)).toBe(true);
    expect(navigate(`${rendererIndexUrl()}?aveWindow=primary`)).toBe(false);
    expect(navigate(`${rendererIndexUrl()}?aveWindow=secondary#x`)).toBe(false);
    expect(navigate("file:///tmp/evil.html")).toBe(false);
    expect(navigate("https://example.com/")).toBe(false);
  });
});
