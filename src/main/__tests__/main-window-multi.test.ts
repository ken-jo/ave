import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../shared/appearance-settings.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { release } from "node:os";
import { resolve } from "node:path";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";

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
    readonly showInactive = vi.fn(() => { this.visible = true; });
    readonly focus = vi.fn();
    readonly setBackgroundColor = vi.fn();
    readonly moveTop = vi.fn();
    readonly restore = vi.fn();
    readonly loadFile = vi.fn(async () => undefined);
    readonly loadURL = vi.fn(async () => undefined);
    private readonly contents = {
      id: this.id * 100,
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      focus: vi.fn(),
      setZoomLevel: vi.fn(),
      setVisualZoomLevelLimits: vi.fn(async () => undefined),
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
    minimized = false;
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    isAlwaysOnTop() { return false; }
    lastClosePrevented = false;
    // What Electron does when nothing prevented `close`.
    close() {
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      this.lastClosePrevented = prevented;
      if (prevented) return this.destroyed;
      this.destroyed = true;
      this.emit("closed");
      return true;
    }
  }
  const nativeTheme = { prefersReducedTransparency: false, shouldUseDarkColors: false, themeSource: "system", on: vi.fn() };
  return { ipcListeners: new Map<string, Listener>(), savedAppearance: undefined as unknown, FakeBrowserWindow, nativeTheme, app: { name: "Ave", isPackaged: false, getPath: vi.fn(() => "/tmp/ave-test"), quit: vi.fn() } };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  ipcMain: { on: (channel: string, listener: Listener) => electronMock.ipcListeners.set(channel, listener) },
  BrowserWindow: electronMock.FakeBrowserWindow,
  nativeTheme: electronMock.nativeTheme,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  shell: { openExternal: vi.fn(async () => undefined) },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  nativeImage: {},
  Tray: class {},
}));
vi.mock("../main-window-host.js", () => ({
  createMainWindowHost: (options: Record<string, unknown>, webPreferences: unknown) => new electronMock.FakeBrowserWindow({ ...options, webPreferences: { contextIsolation: true, nodeIntegration: false, ...(webPreferences as object) } }),
  closeMainWindowUi: (window: InstanceType<typeof electronMock.FakeBrowserWindow>) => { window.destroyed = true; window.emit("closed"); },
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: () => true,
    readFileSync: (path: Parameters<typeof original.readFileSync>[0], options: Parameters<typeof original.readFileSync>[1]) =>
      path === resolve("/tmp/ave-test", "ave-settings.json")
        ? JSON.stringify({ appearance: electronMock.savedAppearance })
        : original.readFileSync(path, options),
  };
});
const osRelease = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, release: () => osRelease.value ?? original.release() };
});
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
const { BOOTSTRAP_SPLASH_URL } = await import("../bootstrap-splash.js");
const { createWindow, getAppWindows, loadMainInterface, rendererIndexUrl, showMainWindow } = await import("../main-window.js");
const { openNewMainWindow, showOrCreatePrimaryMainWindow } = await import("../app-tray.js");
const { promptSurfaceResolver } = await import("../../boot/host-runtime.js");
const { applyAppZoomLevel } = await import("../app-zoom.js");
type FakeWindow = InstanceType<typeof electronMock.FakeBrowserWindow>;

function open(): FakeWindow {
  return createWindow({ showBootstrapSplash: false }) as unknown as FakeWindow;
}

function readAppearance(win: FakeWindow, frameUrl = rendererIndexUrl(), subframe = false): unknown {
  const sender = win.webContents as unknown as { mainFrame: { url: string } };
  sender.mainFrame = { url: frameUrl };
  const event = { sender, senderFrame: subframe ? { url: frameUrl } : sender.mainFrame, returnValue: undefined as unknown };
  const listener = electronMock.ipcListeners.get("ave:settings:initial-appearance");
  if (!listener) throw new Error("Missing appearance listener");
  listener(event);
  return event.returnValue;
}

describe("main windows", () => {
  it("shows the test renderer without raising or activating its window", () => {
    setIsPackaged(false);
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    const win = open();
    try {
      expect(win.options).toMatchObject({ show: false, focusable: false });
      showMainWindow(win as never);
      expect(win.showInactive).toHaveBeenCalledOnce();
      expect(win.focus).not.toHaveBeenCalled();
      expect(win.show).not.toHaveBeenCalled();
      expect(win.moveTop).not.toHaveBeenCalled();
      expect(win.restore).not.toHaveBeenCalled();
      win.minimized = true;
      showMainWindow(win as never);
      expect(win.restore).toHaveBeenCalledOnce();
      expect(win.showInactive).toHaveBeenCalledTimes(2);
      expect(win.focus).not.toHaveBeenCalled();
      expect(win.show).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); _resetForTest(); }
  });
  it.each([{ packaged: false, flag: "" }, { packaged: true, flag: "1" }])("preserves initial visibility outside the unpackaged test runtime (%s)", ({ packaged, flag }) => {
    electronMock.app.isPackaged = packaged;
    setIsPackaged(packaged);
    vi.stubEnv("AVE_E2E", flag);
    vi.stubEnv("NODE_ENV", "test");
    try { expect(open().options).toMatchObject({ show: true }); }
    finally { electronMock.app.isPackaged = false; vi.unstubAllEnvs(); _resetForTest(); }
  });
  beforeEach(() => {
    appState.resetMainWindowsForTests();
    appState.setAppQuitRequested(false);
    appState.setTray({ setContextMenu: vi.fn() } as never);
    appState.setServices(null);
    electronMock.savedAppearance = undefined;
    electronMock.app.quit.mockClear();
  });

  it("sets the saved startup factor for primary and secondary shell windows", () => {
    electronMock.savedAppearance = { schemaVersion: 3, zoomLevel: -3 };
    const shells = [open(), open()];
    const guest = new electronMock.FakeBrowserWindow({});
    for (const win of shells) {
      expect(win.options).toMatchObject({ webPreferences: { zoomFactor: 1.2 ** -3 } });
      expect(win.webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
      expect(win.contentsListeners.has("zoom-changed")).toBe(true);
    }
    applyAppZoomLevel(2);
    for (const win of shells) expect(win.webContents.setZoomLevel).toHaveBeenCalledWith(2);
    expect(guest.webContents.setZoomLevel).not.toHaveBeenCalled();
  });

  it("does not cancel the final native close after application cleanup", () => {
    const window = open();
    appState.setAppShutdownStarted(true);
    appState.setAppShutdownCompleted(true);
    try { expect(window.close()).toBe(true); }
    finally { appState.setAppShutdownStarted(false); appState.setAppShutdownCompleted(false); }
  });

  it("allows an application quit before services and the tray exist to reach native will-quit", () => {
    const window = open();
    appState.setServices(null);
    appState.setTray(null);
    appState.setAppQuitRequested(true);
    try {
      expect(window.close()).toBe(true);
      expect(window.lastClosePrevented).toBe(false);
    } finally { appState.setAppQuitRequested(false); }
  });

  it("still asks the document to unload when the user closes a window during bootstrap", () => {
    const window = open();
    appState.setServices(null);
    appState.setTray(null);
    expect(window.close()).toBe(true);
    expect(window.lastClosePrevented).toBe(true);
  });

  it("holds the native close while application cleanup is still running", () => {
    const window = open();
    appState.setAppShutdownStarted(true);
    try {
      expect(window.close()).toBe(false);
      expect(window.destroyed).toBe(false);
      expect(window.hide).not.toHaveBeenCalled();
    } finally { appState.setAppShutdownStarted(false); }
  });

  it("updates the native ground from host theme changes and releases its subscription", async () => {
    electronMock.nativeTheme.prefersReducedTransparency = true;
    const window = open();
    electronMock.nativeTheme.prefersReducedTransparency = false;
    const { emitEvent } = await import("../../boot/types.js");
    emitEvent("host.theme.changed", { shell: "dark", tokens: { "--ave-bg": "hsl(220, 20%, 10%)" } });
    expect(window.setBackgroundColor).toHaveBeenCalledWith("hsl(220, 20%, 10%)");
    window.emit("closed");
    window.setBackgroundColor.mockClear();
    emitEvent("host.theme.changed", { shell: "light", tokens: { "--ave-bg": "#ffffff" } });
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("opens a centered responsive window without stale appearance arguments", () => {
    const win = open();
    expect(win.options).toMatchObject({
      x: 339, y: 156, width: 1243, height: 768, minWidth: 360,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    expect((win.options as { webPreferences: object }).webPreferences).not.toHaveProperty("additionalArguments");
  });

  it("primes a saved scheme before services exist without a plugin theme cache", () => {
    electronMock.savedAppearance = { schemaVersion: 3, mode: "dark", darkScheme: "nord", lightScheme: "one-light", terminalFont: { family: "Menlo", size: 15, lineHeight: 1.4 } };
    const win = open();
    expect(readAppearance(win)).toMatchObject({ ok: true, appearance: electronMock.savedAppearance });
  });

  it("serves saved appearance to the actual encoded splash URL before services exist", () => {
    electronMock.savedAppearance = { schemaVersion: 3, mode: "dark", darkScheme: "nord", lightScheme: "one-light", terminalFont: { family: "Menlo", size: 15, lineHeight: 1.4 } };
    const win = createWindow() as unknown as FakeWindow;
    expect(win.loadURL).toHaveBeenCalledWith(BOOTSTRAP_SPLASH_URL);
    expect(BOOTSTRAP_SPLASH_URL.startsWith("data:text/html;charset=utf-8,%3C")).toBe(true);
    expect(readAppearance(win, BOOTSTRAP_SPLASH_URL)).toMatchObject({ ok: true, appearance: electronMock.savedAppearance });
    expect(readAppearance(win, BOOTSTRAP_SPLASH_URL + "#unexpected")).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("reads current in-memory appearance after a scheme change and reload", () => {
    const win = open();
    let appearance = { schemaVersion: 3, mode: "dark", darkScheme: "nord", lightScheme: "github-light", terminalFont: { family: "Menlo", size: 12, lineHeight: 1.2 } };
    appState.setServices({ settingsService: { getAll: () => ({ appearance }) } } as never);
    expect(readAppearance(win)).toMatchObject({ ok: true, appearance: { darkScheme: "nord" } });
    appearance = { ...appearance, darkScheme: "tokyo-night" };
    expect(readAppearance(win)).toMatchObject({ ok: true, appearance: { darkScheme: "tokyo-night" } });
  });

  it("creates the window over the system material only where the OS has one and transparency is allowed, and tells its renderer", async () => {
    const { mainWindowGlassMaterial } = await import("../window-chrome.js");
    const material = mainWindowGlassMaterial(process.platform, release());
    const win = open();
    const options = win.options as { vibrancy?: string; backgroundMaterial?: string; backgroundColor?: string; transparent?: boolean };
    expect(options.transparent).toBeUndefined();
    expect(options.vibrancy).toBe(material === "vibrancy" ? "under-window" : undefined);
    expect(options.backgroundMaterial).toBe(material === "mica" ? "mica" : undefined);
    expect(readAppearance(win)).toMatchObject({ ok: true, glass: material === null ? "unsupported" : "on" });
    electronMock.nativeTheme.prefersReducedTransparency = true;
    try {
      const opaque = open();
      const opaqueOptions = opaque.options as { vibrancy?: string; backgroundMaterial?: string };
      expect(opaqueOptions.vibrancy).toBeUndefined();
      expect(opaqueOptions.backgroundMaterial).toBeUndefined();
      expect(readAppearance(opaque)).toMatchObject({ ok: true, glass: material === null ? "unsupported" : "reduced" });
    } finally {
      electronMock.nativeTheme.prefersReducedTransparency = false;
    }
  });

  describe("on Windows", () => {
    const realPlatform = process.platform;
    function asWindows(release: string): void {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      osRelease.value = release;
    }
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      osRelease.value = null;
      electronMock.nativeTheme.prefersReducedTransparency = false;
    });

    it("draws Mica from Windows 11 22H2 (build 22621) and tells the renderer", () => {
      asWindows("10.0.22621");
      const win = open();
      expect(win.options).toMatchObject({ backgroundMaterial: "mica", backgroundColor: "#00000000", frame: false });
      expect(win.options).not.toHaveProperty("vibrancy");
      expect(win.options).not.toHaveProperty("transparent");
      expect(readAppearance(win)).toMatchObject({ ok: true, glass: "on" });
    });

    it("stays opaque but offers the tint control when reduce transparency is on at creation", () => {
      asWindows("10.0.22621");
      electronMock.nativeTheme.prefersReducedTransparency = true;
      const win = open();
      expect(win.options).not.toHaveProperty("backgroundMaterial");
      expect(readAppearance(win)).toMatchObject({ ok: true, glass: "reduced" });
    });

    it("stays opaque with no tint control before 22H2", () => {
      asWindows("10.0.19045");
      const win = open();
      expect(win.options).not.toHaveProperty("backgroundMaterial");
      expect(readAppearance(win)).toMatchObject({ ok: true, glass: "unsupported" });
    });
  });

  it("refuses appearance reads from subframes and navigated documents", () => {
    const win = open();
    expect(readAppearance(win, rendererIndexUrl(), true)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(readAppearance(win, "https://example.test/")).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("refuses appearance reads from windows outside the app renderer registry", () => {
    open();
    const foreignWindow = new electronMock.FakeBrowserWindow({});
    expect(readAppearance(foreignWindow)).toEqual({ ok: false, error: "unauthorized-frame" });
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
      settingsService: { getAll: () => ({ system: { closeBehavior: "quit" }, appearance: { ...DEFAULT_APPEARANCE, mode: "system" } }) },
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
