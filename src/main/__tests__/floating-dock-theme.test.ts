// @vitest-environment jsdom
// The dock receives its initial theme and later updates by IPC; the plugin getTheme guard refuses dock requests.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, relative } from "node:path";
import { SettingsService } from "../../data/settings-store.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { getLocale, setLocale } from "../../i18n/runtime.js";
import { FONT_SIZE_SCALE_DEFAULT } from "../../shared/appearance-font.js";
import { emitEvent } from "../../boot/types.js";
import { getLastThemePayload, recordValidatedTheme, resetLastThemePayloadForTests } from "../../shared/host-theme-replay.js";

const { windows, rendererListeners, invoke } = vi.hoisted(() => ({
  windows: [] as Array<{ send: ReturnType<typeof vi.fn>; fire(event: string): void; args: string[]; attach(prefs: Record<string, unknown>, params: Record<string, string>): boolean; prefs: Record<string, unknown> }>,
  // The dock renderer's `ipcRenderer.on` listeners: what main's `webContents.send` reaches.
  rendererListeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  invoke: vi.fn(),
}));

vi.mock("electron", () => {
  class BrowserWindow {
    #handlers = new Map<string, () => void>();
    // Delivered as Electron delivers it: to the renderer's listeners, behind an event object.
    #contentsHandlers = new Map<string, (...args: unknown[]) => void>();
    webContents = { id: 7, on: (event: string, handler: (...args: unknown[]) => void) => { this.#contentsHandlers.set(event, handler); }, send: vi.fn((channel: string, payload: unknown) => rendererListeners.get(channel)?.forEach((listener) => listener({ sender: "ipc-event" }, payload))) };
    constructor(options: { webPreferences?: Record<string, unknown> & { additionalArguments?: string[] } }) {
      windows.push({
        send: this.webContents.send,
        fire: (event) => this.#handlers.get(event)?.(),
        args: options.webPreferences?.additionalArguments ?? [],
        prefs: options.webPreferences ?? {},
        // A guest attaching: whether the window's handler let it through.
        attach: (prefs, params) => {
          let prevented = false;
          this.#contentsHandlers.get("will-attach-webview")?.({ preventDefault: () => { prevented = true; } }, prefs, params);
          return !prevented;
        },
      });
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

const settingsHome = useTempDirs("dock-settings-");
const settings = {
  get: (key: string) => {
    if (key !== "appearance") throw new Error(`Unexpected settings key: ${key}`);
    return { terminalFont: { family: "Dock Mono" } };
  },
  onChanged: () => () => {},
} as unknown as Pick<SettingsService, "get" | "onChanged">;

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
    }, settings);
    // As the host does: the cache holds a theme before the broadcast carries it.
    return { dock, emit: (theme: unknown) => { current = theme; listener!(theme); } };
  }
  const themesSent = (win: (typeof windows)[number]) =>
    win.send.mock.calls.filter(([channel]) => channel === CHANNELS.dock.theme).map(([, appearance]) => appearance.theme);

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

  it("sends a real durable terminal font change to the dock and replays it on attach", async () => {
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const service = new SettingsService({ userDataPath: settingsHome(), encryption: {
      isAsyncEncryptionAvailable: async () => false, getSelectedStorageBackend: () => "gnome_libsecret",
      encryptStringAsync: vi.fn(), decryptStringAsync: vi.fn(),
    } });
    recordValidatedTheme({ bundleId: "nord", shell: "dark", tokens: THEME.tokens });
    const dock = new ElectronFloatingDockSurface(hostDockThemeSource, service);
    dock.show(BOUNDS);
    const win = windows[0]!;
    win.fire("ready-to-show");
    await service.patch({ appearance: { terminalFont: { family: "Changed Mono" } } });
    expect(win.send).toHaveBeenLastCalledWith(CHANNELS.dock.theme, {
      theme: getLastThemePayload(), terminalFontFamily: "Changed Mono", locale: getLocale(),
    });
    const sent = win.send.mock.calls.length;
    await service.patch({ appearance: { terminalFont: { size: 18 } } });
    expect(win.send).toHaveBeenCalledTimes(sent);
    // The UI font is the snapshot's other settings-owned part: a family or size-scale change repaints the dock too.
    await service.patch({ appearance: { font: { family: "Dock Sans", sizeScale: 1.125 } } });
    expect(win.send).toHaveBeenLastCalledWith(CHANNELS.dock.theme, {
      theme: getLastThemePayload(), terminalFontFamily: "Changed Mono", font: { family: "Dock Sans", sizeScale: 1.125 }, locale: getLocale(),
    });
    // A language change is the snapshot's other settings-derived part: main's resolved locale changes, the dock repaints in it.
    const language = getLocale();
    const other = language === "ko" ? "en" : "ko";
    try {
      setLocale(other);
      expect(win.send).toHaveBeenLastCalledWith(CHANNELS.dock.theme, {
        theme: getLastThemePayload(), terminalFontFamily: "Changed Mono", font: { family: "Dock Sans", sizeScale: 1.125 }, locale: other,
      });
    } finally { setLocale(language); }
    dock.mountSlot("panel", { pluginId: "fixture", title: "Panel", payload: {} } as never, 200);
    expect(win.send.mock.calls.at(-2)).toEqual([CHANNELS.dock.theme, {
      theme: getLastThemePayload(), terminalFontFamily: "Changed Mono", font: { family: "Dock Sans", sizeScale: 1.125 }, locale: getLocale(),
    }]);
  });

  it("opens with the current terminal font after it changes before the dock window exists", async () => {
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const service = new SettingsService({ userDataPath: settingsHome(), encryption: {
      isAsyncEncryptionAvailable: async () => false, getSelectedStorageBackend: () => "gnome_libsecret",
      encryptStringAsync: vi.fn(), decryptStringAsync: vi.fn(),
    } });
    recordValidatedTheme({ bundleId: "nord", shell: "dark", tokens: THEME.tokens });
    const dock = new ElectronFloatingDockSurface(hostDockThemeSource, service);
    await service.patch({ appearance: { terminalFont: { family: "Before Opening Mono" } } });
    expect(windows).toHaveLength(0);

    dock.show(BOUNDS);
    dock.mountSlot("panel", { pluginId: "fixture", title: "Panel", payload: {} } as never, 200);
    const win = windows[0]!;
    expect(win.send).not.toHaveBeenCalled();
    win.fire("ready-to-show");

    const snapshots = win.send.mock.calls.filter(([channel]) => channel === CHANNELS.dock.theme);
    expect(snapshots[0]).toEqual([CHANNELS.dock.theme, {
      theme: getLastThemePayload(), terminalFontFamily: "Before Opening Mono", locale: getLocale(),
    }]);
    expect(snapshots.every(([, appearance]) => appearance.terminalFontFamily === "Before Opening Mono")).toBe(true);
    expect(win.send.mock.calls[0]).toEqual(snapshots[0]);
  });

  it("sends no opening theme before the host has published one", async () => {
    const { dock } = await surface(null);
    dock.show(BOUNDS);
    windows[0]!.fire("ready-to-show");
    expect(themesSent(windows[0]!)).toEqual([]);
  });
});

describe("the dock window's preload, sandbox and guests", () => {
  it("runs its preload in the sandbox the preload table gives it, and attaches only guarded plugin guests", async () => {
    const { ElectronFloatingDockSurface } = await import("../floating-dock-surface.js");
    const { PRELOAD_BUNDLES } = await import("../../shared/preload-bundles.js");
    const { mcpAppPartitionName, MCP_APP_PARTITION_PREFIX } = await import("../../shared/mcp-app-partition.js");
    new ElectronFloatingDockSurface({ onThemeChanged: () => () => {}, currentTheme: () => null }, settings).show(BOUNDS);
    const win = windows[0]!;
    expect(win.prefs).toMatchObject({ preload: `/assets/${PRELOAD_BUNDLES.floatingDockPreload.file}`, sandbox: PRELOAD_BUNDLES.floatingDockPreload.sandbox });
    expect(win.prefs.sandbox).toBe(true);

    // A plugin card's guest: let through, with main's preferences whatever the element asked.
    const prefs: Record<string, unknown> = { sandbox: false, nodeIntegration: true, webviewTag: true };
    expect(win.attach(prefs, { partition: mcpAppPartitionName("meeting"), src: `ave-mcp-app://${mcpAppPartitionName("meeting").slice(MCP_APP_PARTITION_PREFIX.length)}/proxy.html?t=token` })).toBe(true);
    expect(prefs).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false });
    // Anything else is refused.
    expect(win.attach({}, { partition: "persist:elsewhere", src: "https://example.test/" })).toBe(false);
  });
});

describe("the dock window paints the host theme main sends (real preload, host theme feed)", () => {
  const root = join(__dirname, "..", "..");
  const html = readFileSync(join(root, "floating-dock-window.html"), "utf8");


  async function openWindow(_args: string[]) {
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-scheme");
    document.documentElement.removeAttribute("data-shell");
    document.body.innerHTML = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>")).replace(/^<body[^>]*>/u, "").replace(/<script[\s\S]*?<\/script>/gu, "");
    vi.resetModules();
    await import("../../floating-dock-preload.js");
    await import("../../floating-dock-window.js");
  }
  // What the host renderer's theme notify does in main: validate the replay payload, then broadcast (plugins.ts).
  function publish(theme: unknown) {
    const recorded = recordValidatedTheme(theme);
    if (!recorded.ok) throw new Error(recorded.error);
    emitEvent("host.theme.changed", recorded.safe);
  }
  const bg = () => document.documentElement.style.getPropertyValue("--dock-bg");

  it("opens in the theme published before it, repaints for each later one, and asks main for nothing", async () => {
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const dock = new ElectronFloatingDockSurface(hostDockThemeSource, settings);
    publish({ bundleId: "github-dark", shell: "dark", tokens: THEME.tokens });

    dock.show(BOUNDS);
    await openWindow(windows[0]!.args);
    expect(bg()).toBe(""); // the stylesheet's fallback until the window is ready
    windows[0]!.fire("ready-to-show");
    expect(bg()).toBe("hsl(210, 40%, 12%)");

    publish({ bundleId: "github-dark", shell: "dark", tokens: NEXT.tokens });
    expect(bg()).toBe("hsl(210, 40%, 18%)");
    expect(invoke).not.toHaveBeenCalled();

  });

  it("paints the cards' stylesheet tokens on its root from the same scheme, dark and then light", async () => {
    const { resolveTheme } = await import("../../ui/renderer/theme/resolve-theme.js");
    const { requireScheme } = await import("../../ui/renderer/theme/schemes/index.js");
    await openWindow([]);
    // What main's dock.theme post delivers to the dock preload (see the surface tests above for the main side).
    const deliver = (bundleId: string, shell: "light" | "dark") =>
      rendererListeners.get(CHANNELS.dock.theme)?.forEach((listener) => listener({}, { theme: { bundleId, shell, tokens: THEME.tokens }, terminalFontFamily: "Dock Mono", locale: "en" }));
    const root = document.documentElement;
    const token = (name: string) => root.style.getPropertyValue(`--${name}`);

    deliver("nord", "dark");
    const nord = resolveTheme(requireScheme("nord"));
    expect(root.getAttribute("data-scheme")).toBe("nord");
    expect(root.getAttribute("data-shell")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    for (const name of ["background", "foreground", "muted", "muted-foreground", "border"] as const) expect(token(name)).toBe(nord.tokens[name]);
    expect(bg()).toBe(THEME.tokens["--ave-bg"]);

    deliver("github-light", "light");
    const light = resolveTheme(requireScheme("github-light"));
    expect(root.style.getPropertyValue("--ave-font-size-scale")).toBe(String(FONT_SIZE_SCALE_DEFAULT));
    expect(root.style.getPropertyValue("--ave-font-family")).toBe("");
    rendererListeners.get(CHANNELS.dock.theme)?.forEach((listener) => listener({}, { theme: { bundleId: "github-light", shell: "light", tokens: THEME.tokens }, terminalFontFamily: "Dock Mono", font: { family: "Dock Sans", sizeScale: 1.125 }, locale: "en" }));
    // The same font write the main window makes, so the cards' rem utilities and font stack follow the user's choice.
    expect(root.style.getPropertyValue("--ave-font-size-scale")).toBe("1.125");
    expect(root.style.getPropertyValue("--ave-font-family")).toBe("Dock Sans");
    expect(root.getAttribute("data-shell")).toBe("light");
    expect(token("background")).toBe(light.tokens.background);
    expect(token("background")).not.toBe(nord.tokens.background);
  });

  it("is sent a built-in language when main's is an installed-only pack, and paints in it", async () => {
    await openWindow([]);
    // The modules the dock window just loaded: main's side of this test must share their i18n and theme registries.
    const i18n = await import("../../i18n/index.js");
    const replay = await import("../../shared/host-theme-replay.js");
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const previous = i18n.getLocale();
    try {
      i18n.registerInstalledLocales([{ locale: "ja", nativeName: "日本語", englishName: "Japanese" }]);
      i18n.setLocale("ja");
      expect(i18n.getLocale()).toBe("ja");
      replay.recordValidatedTheme({ bundleId: "nord", shell: "dark", tokens: THEME.tokens });
      const dock = new ElectronFloatingDockSurface(hostDockThemeSource, settings);
      dock.show(BOUNDS);
      const win = windows.at(-1)!;
      win.fire("ready-to-show");
      const sent = win.send.mock.calls.filter(([channel]) => channel === CHANNELS.dock.theme).at(-1)?.[1] as { locale: string };
      expect(sent.locale).toBe("en");
      // The dock accepted the snapshot: its root carries the scheme it names.
      expect(document.documentElement.getAttribute("data-scheme")).toBe("nord");
      expect(bg()).toBe(THEME.tokens["--ave-bg"]);
    } finally {
      i18n.setLocale(previous);
      i18n.registerInstalledLocales([]);
    }
  });

  it("reports a language catalog that fails to load, in the console and in the dock, without falling back", async () => {
    await openWindow([]);
    const catalogs = await import("../../i18n/messages/index.js");
    const runtime = await import("../../i18n/runtime.js");
    const previous = runtime.getLocale();
    runtime.setLocale("en");
    const cause = new Error("chunk missing");
    const restore = catalogs.__setLocaleLoaderForTest("ko", () => Promise.reject(cause));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      rendererListeners.get(CHANNELS.dock.theme)?.forEach((listener) => listener({}, { theme: { bundleId: "nord", shell: "dark", tokens: THEME.tokens }, terminalFontFamily: "Dock Mono", locale: "ko" }));
      await vi.waitFor(() => expect(document.getElementById("empty")?.hidden).toBe(false));
      expect(document.getElementById("empty")?.textContent).toBe("The ko interface language could not be loaded.");
      expect(consoleError).toHaveBeenCalledWith("[floating-dock] the ko language catalog failed to load", cause);
      expect(catalogs.isLocaleMessagesLoaded("ko")).toBe(false);
    } finally {
      consoleError.mockRestore();
      restore();
      await catalogs.loadLocaleMessages("ko");
      runtime.setLocale(previous);
    }
  });

  it("stays in the stylesheet's colours when no theme has been published", async () => {
    const { ElectronFloatingDockSurface, hostDockThemeSource } = await import("../floating-dock-surface.js");
    const dock = new ElectronFloatingDockSurface(hostDockThemeSource, settings);
    dock.show(BOUNDS);
    await openWindow(windows[0]!.args);
    windows[0]!.fire("ready-to-show");
    expect(bg()).toBe("");
    expect(document.documentElement.hasAttribute("data-scheme")).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the dock window ships with the app stylesheet its panel cards are written in", () => {
  const srcRoot = join(__dirname, "..", "..");
  const repoRoot = join(srcRoot, "..");
  const html = readFileSync(join(srcRoot, "floating-dock-window.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    build: { files: string[] };
  };
  const { resolveBuildAssets } = createRequire(import.meta.url)("../../../scripts/lib/build-assets.mjs") as {
    resolveBuildAssets(root: string, category: string): Array<{ out: string }>;
  };

  it("links ./styles.css, which build:styles writes next to the built dock html and the packaged app keeps", () => {
    expect(head).toMatch(/<link rel="stylesheet" href="\.\/styles\.css" \/>/u);
    expect(head).toMatch(/style-src 'self'/u);
    const [dockAsset] = resolveBuildAssets(repoRoot, "floating-dock");
    const stylesOut = /--output\s+(\S+)/u.exec(pkg.scripts["build:styles"] ?? "")?.[1];
    expect(stylesOut).toBeDefined();
    expect(join(repoRoot, stylesOut!)).toBe(join(dirname(dockAsset!.out), "styles.css"));
    const packaged = relative(repoRoot, join(repoRoot, stylesOut!)).replaceAll("\\", "/");
    const included = pkg.build.files.filter((pattern) => !pattern.startsWith("!"));
    const excluded = pkg.build.files.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
    expect(included.some((pattern) => matchesGlob(packaged, pattern))).toBe(true);
    expect(excluded.filter((pattern) => matchesGlob(packaged, pattern))).toEqual([]);
  });

  it("leaves the box reset to the stylesheet's preflight so card utility spacing survives", () => {
    // Unlayered rules beat every @layer, so a page-level `*` margin/padding reset would zero mt-2/px-2/py-1 on the cards.
    const inline = head.slice(head.indexOf("<style>"), head.indexOf("</style>"));
    expect(inline).not.toMatch(/(^|[\s}])\*\s*\{[^}]*\b(margin|padding)\s*:/u);
  });
});
