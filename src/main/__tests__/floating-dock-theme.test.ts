// @vitest-environment jsdom
/**
 * The floating dock's own chrome (header, border, activity line) copies four
 * theme colors. It reads them once when its window loads, so every later
 * theme — another theme, or the same theme updated in place — has to reach it:
 * main forwards `host.theme.changed` on `ave:dock:theme`, and the window
 * repaints from it, never letting the slower opening answer win.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";

const { windows } = vi.hoisted(() => ({ windows: [] as Array<{ send: ReturnType<typeof vi.fn>; fire(event: string): void }> }));

vi.mock("electron", () => {
  class BrowserWindow {
    #handlers = new Map<string, () => void>();
    webContents = { id: 7, send: vi.fn() };
    constructor() {
      windows.push({ send: this.webContents.send, fire: (event) => this.#handlers.get(event)?.() });
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
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  };
});
vi.mock("../main-paths.js", () => ({ runtimeAssetPath: (name: string) => `/assets/${name}` }));

const THEME = { bundleId: "harbor", shell: "dark", tokens: { "--ave-fg": "hsl(0, 0%, 100%)", "--ave-bg": "hsl(210, 40%, 12%)", "--ave-border": "hsl(210, 20%, 30%)", "--ave-accent": "hsl(200, 80%, 50%)" } };

afterEach(() => {
  windows.length = 0;
});

describe("ElectronFloatingDockSurface forwards host themes to its window", () => {
  async function surface() {
    const { ElectronFloatingDockSurface } = await import("../floating-dock-surface.js");
    let listener: ((theme: unknown) => void) | null = null;
    const dock = new ElectronFloatingDockSurface({ onThemeChanged: (next) => { listener = next; return () => {}; } });
    return { dock, emit: (theme: unknown) => listener!(theme) };
  }

  it("sends each theme to the open window, queued until it is ready", async () => {
    const { dock, emit } = await surface();
    emit(THEME); // no window yet: the next one asks `getTheme` itself
    dock.show({ x: 0, y: 0, width: 360, height: 120 });
    const win = windows[0]!;
    const next = { ...THEME, tokens: { ...THEME.tokens, "--ave-bg": "hsl(210, 40%, 18%)" } };
    emit(next);
    expect(win.send).not.toHaveBeenCalled();

    win.fire("ready-to-show");
    expect(win.send).toHaveBeenCalledWith(CHANNELS.dock.theme, next);

    emit(THEME);
    expect(win.send).toHaveBeenLastCalledWith(CHANNELS.dock.theme, THEME);
  });
});

describe("floating-dock-window.js repaints its chrome", () => {
  const root = join(__dirname, "..", "..");
  const html = readFileSync(join(root, "floating-dock-window.html"), "utf8");
  const script = readFileSync(join(root, "floating-dock-window.js"), "utf8");

  function load() {
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>")).replace(/^<body[^>]*>/u, "").replace(/<script[\s\S]*?<\/script>/gu, "");
    let opening: (theme: unknown) => void = () => {};
    let pushed: (theme: unknown) => void = () => {};
    (window as unknown as { aveDock: unknown }).aveDock = {
      getTheme: () => new Promise((resolve) => { opening = resolve; }),
      onTheme: (handler: (theme: unknown) => void) => { pushed = handler; return () => {}; },
      onActivity: () => () => {},
      onMount: () => () => {},
      onResize: () => () => {},
      onUnmount: () => () => {},
      requestClose: () => {},
      reportSlotGone: () => {},
    };
    new Function(script)();
    return { opening: (theme: unknown) => opening(theme), pushed: (theme: unknown) => pushed(theme) };
  }

  const bg = () => document.documentElement.style.getPropertyValue("--dock-bg");

  it("paints the opening theme, then every pushed one", async () => {
    const dock = load();
    dock.opening(THEME);
    await vi.waitFor(() => expect(bg()).toBe("hsl(210, 40%, 12%)"));

    dock.pushed({ ...THEME, tokens: { ...THEME.tokens, "--ave-bg": "hsl(210, 40%, 18%)" } });
    expect(bg()).toBe("hsl(210, 40%, 18%)");
  });

  it("keeps a pushed theme when the opening answer arrives after it", async () => {
    const dock = load();
    dock.pushed({ ...THEME, tokens: { ...THEME.tokens, "--ave-bg": "hsl(210, 40%, 18%)" } });
    dock.opening(THEME);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bg()).toBe("hsl(210, 40%, 18%)");
  });
});
