/**
 * Several main windows: registration roles, the close policy (only the last
 * window follows hide-to-tray), the secondary role reaching the renderer, and
 * the app document staying the only thing a main window may navigate to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  let nextId = 1;
  class FakeBrowserWindow {
    readonly id = nextId++;
    readonly listeners = new Map<string, Listener[]>();
    readonly contentsListeners = new Map<string, Listener[]>();
    destroyed = false;
    readonly hide = vi.fn();
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly moveTop = vi.fn();
    readonly restore = vi.fn();
    readonly loadFile = vi.fn(async () => undefined);
    readonly loadURL = vi.fn(async () => undefined);
    readonly webContents = {
      id: this.id * 100,
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      on: (name: string, fn: Listener) => this.pushContents(name, fn),
      once: (name: string, fn: Listener) => this.pushContents(name, fn),
      send: vi.fn(),
    };
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
    /** What Electron does when nothing prevented `close`. */
    close() {
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      if (prevented) return false;
      this.destroyed = true;
      this.emit("closed");
      return true;
    }
  }
  return { FakeBrowserWindow, app: { getPath: vi.fn(() => "/tmp/ave-test"), quit: vi.fn() } };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.FakeBrowserWindow,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  shell: { openExternal: vi.fn(async () => undefined) },
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));
vi.mock("../persisted-app-mode.js", () => ({ readPersistedAppModeSync: () => "work" }));
vi.mock("../native-window-coordinator.js", () => ({ requestNativeChromeRefresh: vi.fn() }));

const appState = await import("../app-state.js");
const { createWindow, getAppWindows, loadMainInterface, rendererIndexUrl } = await import("../main-window.js");
type FakeWindow = InstanceType<typeof electronMock.FakeBrowserWindow>;

function open(): FakeWindow {
  return createWindow({ showBootstrapSplash: false }) as unknown as FakeWindow;
}

describe("main windows", () => {
  beforeEach(() => {
    appState.resetMainWindowsForTests();
    appState.setTray({} as never);
    appState.setServices(null);
    electronMock.app.quit.mockClear();
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
    // The primary role is free again: the next window opened claims it.
    expect(appState.getPrimaryMainWindow()).toBeNull();

    expect(second.close()).toBe(false);
    expect(second.hide).toHaveBeenCalledOnce();
    expect(getAppWindows()).toEqual([second]);

    const third = open();
    expect(appState.getPrimaryMainWindow()).toBe(third);
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
