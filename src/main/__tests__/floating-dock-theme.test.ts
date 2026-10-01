// @vitest-environment jsdom
/**
 * The floating dock's own chrome (header, border, activity line) copies four
 * theme colors. Main sends them on `ave:dock:theme`: the theme current when
 * the window opens, then every later one — another theme, or the same theme
 * updated in place. The window asks for nothing (the plugin `getTheme` guard
 * refuses it; see plugin-theme-replay.test.ts for the real handler).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { emitEvent } from "../../boot/types.js";
import { recordValidatedTheme, resetLastThemePayloadForTests } from "../../shared/plugin-theme-cache.js";

const { windows, rendererListeners, invoke } = vi.hoisted(() => ({
  windows: [] as Array<{ send: ReturnType<typeof vi.fn>; fire(event: string): void; args: string[] }>,
  /** The dock renderer's `ipcRenderer.on` listeners: what main's `webContents.send` reaches. */
  rendererListeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  invoke: vi.fn(),
}));

vi.mock("electron", () => {
  class BrowserWindow {
    #handlers = new Map<string, () => void>();
    // Delivered as Electron delivers it: to the renderer's listeners, behind an event object.
    webContents = { id: 7, send: vi.fn((channel: string, payload: unknown) => rendererListeners.get(channel)?.forEach((listener) => listener({ sender: "ipc-event" }, payload))) };
    constructor(options: { webPreferences?: { additionalArguments?: string[] } }) {
      windows.push({ send: this.webContents.send, fire: (event) => this.#handlers.get(event)?.(), args: options.webPreferences?.additionalArguments ?? [] });
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    once(event: string, handler: () => void) { this.#handlers.set(event, handler); }
    on(event: string, handler: () => void) { this.#handlers.set(event, handler); }
    loadFile() { return Promise.resolve(); }
    show() {}
    isDestroyed() { return false; }
  }
  return {
    BrowserWindow,
    ipcMain: { on: vi.fn() },
    // The dock preload's side, so the window script runs on the real bridge.
    contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { (window as unknown as Record<string, unknown>)[key] = api; } },
    ipcRenderer: {
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
        if (!rendererListeners.has(channel)) rendererListeners.set(channel, new Set());
        rendererListeners.get(channel)!.add(listener);
      },
      removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => rendererListeners.get(channel)?.delete(listener),
      invoke,
      send: vi.fn(),
    },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  };
});
vi.mock("../main-paths.js", () => ({ runtimeAssetPath: (name: string) => `/assets/${name}` }));

const THEME = { bundleId: "harbor", shell: "dark", tokens: { "--ave-fg": "hsl(0, 0%, 100%)", "--ave-bg": "hsl(210, 40%, 12%)", "--ave-border": "hsl(210, 20%, 30%)", "--ave-accent": "hsl(200, 80%, 50%)" } };

afterEach(() => {
  windows.length = 0;
  rendererListeners.clear();
  invoke.mockReset();
  resetLastThemePayloadForTests();
});

const NEXT = { ...THEME, tokens: { ...THEME.tokens, "--ave-bg": "hsl(210, 40%, 18%)" } };
const BOUNDS = { x: 0, y: 0, width: 360, height: 120 };

describe("ElectronFloatingDockSurface sends host themes to its window", () => {
  async function surface(initial: unknown) {
    const { ElectronFloatingDockSurface } = await import("../floating-dock-surface.js");
    let listener: ((theme: unknown) => void) | null = null;
    let current = initial;
    const dock = new ElectronFloatingDockSurface({
      onThemeChanged: (next) => { listener = next; return () => {}; },
      currentTheme: () => current,
    });
    // As the host does: the cache holds a theme before the broadcast carries it.
    return { dock, emit: (theme: unknown) => { current = theme; listener!(theme); } };
  }
  const themesSent = (win: (typeof windows)[number]) =>
    win.send.mock.calls.filter(([channel]) => channel === CHANNELS.dock.theme).map(([, theme]) => theme);

  it("sends the theme current when the window opens, then each later one, in order once it is ready", async () => {
    const { dock, emit } = await surface(THEME);
    dock.show(BOUNDS);
    const win = windows[0]!;
    emit(NEXT);
    expect(win.send).not.toHaveBeenCalled();

    win.fire("ready-to-show");
    expect(themesSent(win)).toEqual([THEME, NEXT]);

    emit(THEME);
    expect(themesSent(win)).toEqual([THEME, NEXT, THEME]);
  });

  it("sends a reopened window the theme that changed while the dock was closed, and the closed one nothing", async () => {
    const { dock, emit } = await surface(THEME);
    dock.show(BOUNDS);
    const first = windows[0]!;
    first.fire("ready-to-show");
    first.fire("closed");
    first.send.mockClear();

    emit(NEXT);
    expect(first.send).not.toHaveBeenCalled();

    dock.show(BOUNDS);
    const second = windows[1]!;
    second.fire("ready-to-show");
    expect(themesSent(second)).toEqual([NEXT]);
  });

  it("sends no opening theme before the host has published one", async () => {
    const { dock } = await surface(null);
    dock.show(BOUNDS);
    windows[0]!.fire("ready-to-show");
    expect(themesSent(windows[0]!)).toEqual([]);
  });
});

describe("the dock window paints the host theme main sends (real preload, host theme feed)", () => {
  const root = join(__dirname, "..", "..");
  const html = readFileSync(join(root, "floating-dock-window.html"), "utf8");
  const script = readFileSync(join(root, "floating-dock-window.js"), "utf8");

  let preloadBridge: unknown = null;
  /** The dock window as it opens: its preload's bridge, then its script. */
  async function openWindow(args: string[]) {
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>")).replace(/^<body[^>]*>/u, "").replace(/<script[\s\S]*?<\/script>/gu, "");
    // Imported once (it exposes the bridge at load); each window gets that bridge.
    const w = window as unknown as Record<string, unknown>;
    if (!preloadBridge) {
      // The sandboxed preload reads its asset URLs from the arguments main gave the window.
      const argv = process.argv;
      process.argv = [...argv, ...args];
      try {
        await import("../../floating-dock-preload.js");
      } finally {
        process.argv = argv;
      }
      preloadBridge = w.aveDock;
    }
    w.aveDock = preloadBridge;
    new Function(script)();
  }
  /** What the host renderer's theme notify does in main: validate into the cache, then broadcast (plugins.ts). */
  function publish(theme: unknown) {
    const recorded = recordValidatedTheme(theme);
    if (!recorded.ok) throw new Error(recorded.error);
    emitEvent("host.theme.changed", recorded.safe);
  }
  const bg = () => document.documentElement.style.getPropertyValue("--dock-bg");

  it("opens in the theme published before it, repaints for each later one, and asks main for nothing", async () => {
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const dock = new ElectronFloatingDockSurface(hostDockThemeSource);
    publish({ bundleId: "moonstone", shell: "dark", tokens: THEME.tokens });

    dock.show(BOUNDS);
    await openWindow(windows[0]!.args);
    expect(bg()).toBe(""); // the stylesheet's fallback until the window is ready
    windows[0]!.fire("ready-to-show");
    expect(bg()).toBe("hsl(210, 40%, 12%)");

    publish({ bundleId: "moonstone", shell: "dark", tokens: NEXT.tokens });
    expect(bg()).toBe("hsl(210, 40%, 18%)");
    expect(invoke).not.toHaveBeenCalled();
    // The asset URLs main resolved reach the bridge (the preload resolves nothing itself).
    const bridge = (window as unknown as { aveDock: { pluginShellUrl: string; pluginPreloadUrl: string } }).aveDock;
    expect(bridge.pluginShellUrl).toBe("file:///assets/plugin-ui-shell.html");
    expect(bridge.pluginPreloadUrl).toBe("file:///assets/plugin-preload.cjs");
  });

  it("stays in the stylesheet's colours when no theme has been published", async () => {
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const dock = new ElectronFloatingDockSurface(hostDockThemeSource);
    dock.show(BOUNDS);
    await openWindow(windows[0]!.args);
    windows[0]!.fire("ready-to-show");
    expect(bg()).toBe("");
    expect(invoke).not.toHaveBeenCalled();
  });
});
