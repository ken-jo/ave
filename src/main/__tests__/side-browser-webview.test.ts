import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";

useChromiumRuntime();

const electronMock = vi.hoisted(() => {
  const sideBrowserSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setUserAgent: vi.fn(),
    on: vi.fn(),
  };
  const otherSession = {};
  return { sideBrowserSession, otherSession };
});

vi.mock("electron", () => ({
  app: { getVersion: () => "0.14.1" },
  session: {
    fromPartition: vi.fn((partition: string) =>
      partition === "persist:ave-side-browser" ? electronMock.sideBrowserSession : electronMock.otherSession
    ),
  },
}));

const workspace = vi.hoisted(() => ({
  requestPermission: vi.fn(async (_guestId: number, _permission: string, _details: unknown) => true),
  checkPermission: vi.fn((_guestId: number, _permission: string, _details: unknown) => true),
  observeGuest: vi.fn(), observeDownload: vi.fn(), registerPopup: vi.fn(() => "tab-popup"),
}));
vi.mock("../browser/browser-workspace-desktop.js", () => ({
  getBrowserWorkspaceService: () => workspace,
  browserWorkspaceGuestWindowId: (contents: { id?: number } | null) => typeof contents?.id === "number" ? 1 : null,
  observeBrowserWorkspaceGuest: workspace.observeGuest,
  observeBrowserWorkspaceDownload: workspace.observeDownload,
  registerBrowserWorkspacePopup: workspace.registerPopup,
}));

beforeEach(() => vi.clearAllMocks());

const {
  DOWNLOAD_PROMPTS_PER_ORIGIN,
  DOWNLOAD_RATE_WINDOW_MS,
  attachSideBrowserWebview,
  configureSideBrowserWebviewAttach,
  createSideBrowserDownloadPolicy,
  installSideBrowserPartitionPolicy,
  isSideBrowserContents,
  isSideBrowserPopupUrlAllowed,
} = await import("../side-browser-webview.js");
const { buildPersistentBrowserUserAgent } = await import("../browser-user-agent.js");

function event() {
  return { preventDefault: vi.fn() };
}

describe("side browser webview attach policy", () => {
  it("accepts http(s) side-browser webviews and forces isolated JS-capable preferences", () => {
    const attachEvent = event();
    const prefs: Record<string, unknown> = {
      preload: "evil.js",
      nodeIntegration: true,
      sandbox: false,
    };

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: {
        partition: AVE_SIDE_BROWSER_PARTITION,
        src: "https://example.com/docs",
      },
    });

    expect(result).toBe("accepted");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.javascript).toBe(true);
    expect(prefs.partition).toBe(AVE_SIDE_BROWSER_PARTITION);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank#script",
    "about:blank?script=1",
    "about:srcdoc",
  ])("blocks non-http side-browser attachment to %s", (src) => {
    const attachEvent = event();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: {},
      params: {
        partition: AVE_SIDE_BROWSER_PARTITION,
        src,
      },
    });

    expect(result).toBe("blocked");
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("accepts the exact blank document for a guarded tab bootstrap", () => {
    const attachEvent = event();
    const prefs: Record<string, unknown> = { preload: "untrusted.js", nodeIntegration: true };

    expect(configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: { partition: AVE_SIDE_BROWSER_PARTITION, src: "about:blank" },
    })).toBe("accepted");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    expect(prefs.preload).toBeUndefined();
  });

  it("blocks credentialed side-browser URLs", () => {
    const attachEvent = event();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: {},
      params: {
        partition: AVE_SIDE_BROWSER_PARTITION,
        src: "https://user:pass@example.com/docs",
      },
    });

    expect(result).toBe("blocked");
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores unrelated webviews", () => {
    const attachEvent = event();
    const prefs: Record<string, unknown> = { nodeIntegration: true };

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: {
        // A per-server MCP-app partition (#885 b1) — unrelated to the side browser, so the attach configurer must leave it alone ("ignored").
        partition: "ave-mcp-app:676974687562",
        src: "data:text/html,ok",
      },
    });

    expect(result).toBe("ignored");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(prefs.nodeIntegration).toBe(true);
  });

  it("installs a browser-like UA, verified permission callbacks, and a download policy", async () => {
    installSideBrowserPartitionPolicy();

    const ua = electronMock.sideBrowserSession.setUserAgent.mock.calls[0]?.[0] as string;
    expect(ua).toBe(buildPersistentBrowserUserAgent());
    expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36 Ave\/\S+$/);
    expect(ua).not.toMatch(/Electron\/|Edg\//);
    expect(electronMock.sideBrowserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(electronMock.sideBrowserSession.setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));
    // Downloads are allowed, behind the Save-dialog policy below.
    expect(electronMock.sideBrowserSession.on).toHaveBeenCalledWith("will-download", expect.any(Function));

    const requestHandler = electronMock.sideBrowserSession.setPermissionRequestHandler.mock.calls[0]?.[0] as
      (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    const checkHandler = electronMock.sideBrowserSession.setPermissionCheckHandler.mock.calls[0]?.[0] as
      (webContents: unknown, permission: string) => boolean;
    const contents = { id: 71, session: electronMock.sideBrowserSession, isDestroyed: () => false, getURL: () => "https://site.example/" };
    // `fullscreen` is denied: a fullscreen page could cover the app and spoof its approval UI.
    for (const denied of ["fullscreen", "media", "geolocation", "notifications", "midi", "hid", "openExternal"]) {
      const callback = vi.fn();
      requestHandler(contents, denied, callback);
      expect(callback).toHaveBeenCalledWith(false);
      expect(checkHandler(contents, denied)).toBe(false);
    }
    for (const allowed of ["clipboard-sanitized-write"]) {
      const callback = vi.fn();
      requestHandler(contents, allowed, callback);
      await Promise.resolve();
      expect(callback).toHaveBeenCalledWith(true);
      expect(checkHandler(contents, allowed)).toBe(true);
    }
  });

  it("forwards actual native main-frame details and rejects frame/origin substitutions", async () => {
    installSideBrowserPartitionPolicy();
    const request = electronMock.sideBrowserSession.setPermissionRequestHandler.mock.calls[0]![0];
    const check = electronMock.sideBrowserSession.setPermissionCheckHandler.mock.calls[0]![0];
    const contents = { id: 71, session: electronMock.sideBrowserSession, isDestroyed: () => false, getURL: () => "https://site.example/page" };
    const details = { requestingUrl: "https://site.example/page", isMainFrame: true, mediaTypes: ["video"] };
    const allowed = vi.fn();
    request(contents, "media", allowed, details);
    await Promise.resolve();
    expect(workspace.requestPermission).toHaveBeenCalledWith(71, "media", details);
    expect(workspace.requestPermission.mock.calls[0]![2]).toBe(details);
    expect(allowed).toHaveBeenCalledWith(true);
    expect(check(contents, "media", "https://site.example", { ...details, mediaType: "video" })).toBe(true);
    for (const invalid of [
      { ...details, isMainFrame: false }, { ...details, isMainFrame: undefined },
      { ...details, requestingUrl: "https://site.example/other" },
      { ...details, requestingUrl: "https://other.example/page" },
      { ...details, embeddingOrigin: "https://other.example" },
      { ...details, securityOrigin: "https://other.example" },
    ]) {
      const denied = vi.fn();
      request(contents, "media", denied, invalid);
      expect(denied).toHaveBeenCalledWith(false);
      expect(check(contents, "media", "https://site.example", invalid)).toBe(false);
    }
    expect(check(contents, "media", "https://other.example", details)).toBe(false);
    expect(check(null, "media", "https://site.example", details)).toBe(false);
    expect(check({ ...contents, session: electronMock.otherSession }, "media", "https://site.example", details)).toBe(false);
    expect(workspace.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("adds download observation only after the existing Save and rate admission", () => {
    installSideBrowserPartitionPolicy();
    const download = electronMock.sideBrowserSession.on.mock.calls.find(([name]) => name === "will-download")![1];
    const contents = { id: 71, getURL: () => "https://site.example/" };
    const item = { getURL: () => "https://site.example/report", getSavePath: () => "", on: vi.fn() };
    const first = event();
    download(first, item, contents);
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(workspace.observeDownload).toHaveBeenCalledWith(contents, item);
    const second = event();
    download(second, item, contents);
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(workspace.observeDownload).toHaveBeenCalledTimes(1);
  });

  it("allows only concrete http(s) popup URLs", () => {
    expect(isSideBrowserPopupUrlAllowed("https://accounts.google.com/o/oauth2/auth")).toBe(true);
    expect(isSideBrowserPopupUrlAllowed("http://example.com/")).toBe(true);
    for (const blocked of [
      "about:blank",
      "",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "ave://settings",
      "ms-msdt:/id",
      "about:srcdoc",
      "https://user:pass@example.com/",
    ]) {
      expect(isSideBrowserPopupUrlAllowed(blocked)).toBe(false);
    }
  });

  function fakeContents(session: unknown) {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let openHandler: ((details: { url: string }) => { action: string; overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown>; parent?: unknown } }) | null = null;
    return {
      id: Math.floor(Math.random() * 1e9),
      session,
      once: vi.fn(),
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
        listeners.set(name, listener);
      }),
      setWindowOpenHandler: vi.fn((handler: typeof openHandler) => {
        openHandler = handler;
      }),
      emit: (name: string, ...args: unknown[]) => listeners.get(name)?.(...args),
      open: (url: string) => openHandler!({ url }),
    };
  }

  function fakeOwner() {
    let destroyed = false;
    return { isDestroyed: () => destroyed, destroy: () => { destroyed = true; } };
  }

  it("denies ambiguous blank popup requests before creating a window", () => {
    const guest = fakeContents(electronMock.sideBrowserSession);
    attachSideBrowserWebview(guest as never, fakeOwner() as never);

    expect(guest.open("about:blank")).toEqual({ action: "deny" });
  });

  it("lets the guest open hardened popup windows and guards each popup recursively", () => {
    const owner = fakeOwner();
    const guest = fakeContents(electronMock.sideBrowserSession);
    attachSideBrowserWebview(guest as never, owner as never);

    expect(guest.open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(guest.open("data:text/html,<script>alert(1)</script>")).toEqual({ action: "deny" });
    const allowed = guest.open("https://accounts.google.com/signin");
    expect(allowed.action).toBe("allow");
    const prefs = allowed.overrideBrowserWindowOptions?.webPreferences ?? {};
    expect(prefs).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    });
    expect(prefs.preload).toBeUndefined();
    // Parented to the owning main window, so the popup closes with it.
    expect(allowed.overrideBrowserWindowOptions?.parent).toBe(owner);

    const popupContents = fakeContents(electronMock.sideBrowserSession);
    const popup = { webContents: popupContents, destroy: vi.fn() };
    guest.emit("did-create-window", popup);
    expect(popup.destroy).not.toHaveBeenCalled();
    // The popup carries the same guards: its own popups and navigations.
    expect(popupContents.open("file:///etc/passwd")).toEqual({ action: "deny" });
    const nav = { url: "ave://x", preventDefault: vi.fn() };
    popupContents.emit("will-navigate", nav);
    expect(nav.preventDefault).toHaveBeenCalledOnce();
    const redirect = { url: "https://accounts.google.com/next", preventDefault: vi.fn() };
    popupContents.emit("will-redirect", redirect);
    expect(redirect.preventDefault).not.toHaveBeenCalled();
    // A popup's own popup keeps the same owner as its parent.
    const nested = popupContents.open("https://accounts.google.com/consent");
    expect(nested.overrideBrowserWindowOptions?.parent).toBe(owner);
  });

  it("opens no popup once the owning main window is gone", () => {
    const owner = fakeOwner();
    const guest = fakeContents(electronMock.sideBrowserSession);
    attachSideBrowserWebview(guest as never, owner as never);
    owner.destroy();
    expect(guest.open("https://accounts.google.com/signin")).toEqual({ action: "deny" });
  });

  it("destroys a popup that did not land on the side-browser session", () => {
    const owner = fakeOwner();
    const guest = fakeContents(electronMock.sideBrowserSession);
    attachSideBrowserWebview(guest as never, owner as never);
    const stray = { webContents: fakeContents(electronMock.otherSession), destroy: vi.fn() };
    guest.emit("did-create-window", stray);
    expect(stray.destroy).toHaveBeenCalledOnce();
    expect(stray.webContents.setWindowOpenHandler).not.toHaveBeenCalled();
  });

  it("verifies attached webContents by session before link-owned registration", () => {
    expect(isSideBrowserContents({ session: electronMock.sideBrowserSession } as never)).toBe(true);
    expect(isSideBrowserContents({ session: electronMock.otherSession } as never)).toBe(false);
  });

  describe("download policy", () => {
    function fakeItem(url = "https://files.example.com/report.pdf") {
      const listeners = new Map<string, Array<() => void>>();
      let savePath = "";
      return {
        getURL: () => url,
        getSavePath: () => savePath,
        setSavePath: vi.fn(),
        on: vi.fn((name: string, listener: () => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        }),
        pickPath: (path: string) => {
          savePath = path;
          for (const listener of listeners.get("updated") ?? []) listener();
        },
        finish: () => {
          for (const listener of listeners.get("done") ?? []) listener();
        },
      };
    }
    function page(id: number, url = "https://files.example.com/list") {
      return { id, getURL: () => url };
    }
    function policy(clock = { at: 0 }) {
      const warn = vi.fn();
      const handle = createSideBrowserDownloadPolicy({ now: () => clock.at, warn });
      return { handle, warn, clock };
    }

    it("lets a download through to the native Save dialog without presetting a path or opening the file", async () => {
      const { handle, warn } = policy();
      const download = event();
      const item = fakeItem();
      handle(download, item as never, page(1) as never);
      expect(download.preventDefault).not.toHaveBeenCalled();
      expect(item.setSavePath).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      // Nothing in the module can open a saved file: it never imports shell.
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(new URL("../side-browser-webview.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/\bshell\b|openPath|setSavePath\(/);
    });

    it("cancels a second download while that side browser's Save dialog is still open", () => {
      const { handle, warn, clock } = policy();
      const first = fakeItem();
      handle(event(), first as never, page(1) as never);

      const second = event();
      handle(second, fakeItem() as never, page(1) as never);
      expect(second.preventDefault).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();

      // Another side browser has its own dialog slot.
      const elsewhere = event();
      handle(elsewhere, fakeItem() as never, page(2, "https://other.example.org/") as never);
      expect(elsewhere.preventDefault).not.toHaveBeenCalled();

      // Once the user picked a path the dialog is closed and a new prompt may open.
      first.pickPath("/Users/me/Downloads/report.pdf");
      clock.at += 1;
      const afterPick = event();
      handle(afterPick, fakeItem() as never, page(1) as never);
      expect(afterPick.preventDefault).not.toHaveBeenCalled();
    });

    it("frees the dialog slot when the download is cancelled from the dialog", () => {
      const { handle } = policy();
      const first = fakeItem();
      handle(event(), first as never, page(1) as never);
      first.finish();
      const next = event();
      handle(next, fakeItem() as never, page(1) as never);
      expect(next.preventDefault).not.toHaveBeenCalled();
    });

    it("cancels and logs download prompts beyond the per-origin rate limit", () => {
      const { handle, warn, clock } = policy();
      for (let i = 0; i < DOWNLOAD_PROMPTS_PER_ORIGIN; i += 1) {
        const item = fakeItem();
        const allowed = event();
        handle(allowed, item as never, page(1) as never);
        expect(allowed.preventDefault).not.toHaveBeenCalled();
        item.finish();
        clock.at += 1_000;
      }
      const over = event();
      handle(over, fakeItem() as never, page(1) as never);
      expect(over.preventDefault).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ origin: "https://files.example.com" }),
        expect.stringContaining("too many download prompts"),
      );

      // The limit is per origin: another site is unaffected.
      const otherOrigin = event();
      handle(otherOrigin, fakeItem() as never, page(3, "https://other.example.org/") as never);
      expect(otherOrigin.preventDefault).not.toHaveBeenCalled();

      // After the window passes the origin may prompt again.
      clock.at += DOWNLOAD_RATE_WINDOW_MS;
      const later = event();
      handle(later, fakeItem() as never, page(1) as never);
      expect(later.preventDefault).not.toHaveBeenCalled();
    });
  });
});
