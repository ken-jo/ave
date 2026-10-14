import { describe, expect, it, vi } from "vitest";
import { AVE_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";

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
  session: {
    fromPartition: vi.fn((partition: string) =>
      partition === "persist:ave-side-browser" ? electronMock.sideBrowserSession : electronMock.otherSession
    ),
  },
}));

const {
  attachSideBrowserWebview,
  configureSideBrowserWebviewAttach,
  installSideBrowserPartitionPolicy,
  isSideBrowserContents,
  isSideBrowserPopupUrlAllowed,
  takePendingSideBrowserSrc,
} = await import("../side-browser-webview.js");

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
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: {
        partition: AVE_SIDE_BROWSER_PARTITION,
        src: "https://example.com/docs",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("accepted");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(enqueueAllowedSrc).toHaveBeenCalledWith("https://example.com/docs");
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.javascript).toBe(true);
    expect(prefs.partition).toBe(AVE_SIDE_BROWSER_PARTITION);
  });

  it("blocks non-http side-browser navigations", () => {
    const attachEvent = event();
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: {},
      params: {
        partition: AVE_SIDE_BROWSER_PARTITION,
        src: "javascript:alert(1)",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("blocked");
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();
    expect(enqueueAllowedSrc).not.toHaveBeenCalled();
  });

  it("blocks credentialed side-browser URLs", () => {
    const attachEvent = event();
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: {},
      params: {
        partition: AVE_SIDE_BROWSER_PARTITION,
        src: "https://user:pass@example.com/docs",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("blocked");
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();
    expect(enqueueAllowedSrc).not.toHaveBeenCalled();
  });

  it("ignores unrelated webviews", () => {
    const attachEvent = event();
    const prefs: Record<string, unknown> = { nodeIntegration: true };
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: {
        // A per-server MCP-app partition (#885 b1) — unrelated to the side
        // browser, so the attach configurer must leave it alone ("ignored").
        partition: "ave-mcp-app:676974687562",
        src: "data:text/html,ok",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("ignored");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(enqueueAllowedSrc).not.toHaveBeenCalled();
    expect(prefs.nodeIntegration).toBe(true);
  });

  it("matches attached guests by URL instead of blindly shifting the pending queue", () => {
    const pending = ["https://example.com/docs", "https://google.com/"];

    expect(takePendingSideBrowserSrc(pending, "https://unrelated.example/")).toBeNull();
    expect(pending).toEqual(["https://example.com/docs", "https://google.com/"]);
    expect(takePendingSideBrowserSrc(pending, "https://google.com/")).toBe("https://google.com/");
    expect(pending).toEqual(["https://example.com/docs"]);
  });

  it("installs a browser-like UA, a narrow permission allow-list without fullscreen, and leaves downloads to the native save dialog", () => {
    installSideBrowserPartitionPolicy();

    const ua = electronMock.sideBrowserSession.setUserAgent.mock.calls[0]?.[0] as string;
    expect(ua).toMatch(/Chrome\/\d+/);
    expect(ua).not.toContain("Electron");
    expect(electronMock.sideBrowserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(electronMock.sideBrowserSession.setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));
    // No download veto: Electron's default routine prompts a Save dialog.
    expect(electronMock.sideBrowserSession.on).not.toHaveBeenCalledWith("will-download", expect.any(Function));

    const requestHandler = electronMock.sideBrowserSession.setPermissionRequestHandler.mock.calls[0]?.[0] as
      (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    const checkHandler = electronMock.sideBrowserSession.setPermissionCheckHandler.mock.calls[0]?.[0] as
      (webContents: unknown, permission: string) => boolean;
    // `fullscreen` is denied: a fullscreen page could cover the app and spoof its approval UI.
    for (const denied of ["fullscreen", "media", "geolocation", "notifications", "midi", "hid", "openExternal"]) {
      const callback = vi.fn();
      requestHandler({}, denied, callback);
      expect(callback).toHaveBeenCalledWith(false);
      expect(checkHandler({}, denied)).toBe(false);
    }
    for (const allowed of ["clipboard-sanitized-write"]) {
      const callback = vi.fn();
      requestHandler({}, allowed, callback);
      expect(callback).toHaveBeenCalledWith(true);
      expect(checkHandler({}, allowed)).toBe(true);
    }
  });

  it("allows only http(s) and about:blank popups", () => {
    expect(isSideBrowserPopupUrlAllowed("https://accounts.google.com/o/oauth2/auth")).toBe(true);
    expect(isSideBrowserPopupUrlAllowed("http://example.com/")).toBe(true);
    expect(isSideBrowserPopupUrlAllowed("about:blank")).toBe(true);
    for (const blocked of [
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
    let openHandler: ((details: { url: string }) => { action: string; overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> } }) | null = null;
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

  it("lets the guest open hardened popup windows and guards each popup recursively", () => {
    const guest = fakeContents(electronMock.sideBrowserSession);
    attachSideBrowserWebview(guest as never);

    expect(guest.open("javascript:alert(1)")).toEqual({ action: "deny" });
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
  });

  it("destroys a popup that did not land on the side-browser session", () => {
    const guest = fakeContents(electronMock.sideBrowserSession);
    attachSideBrowserWebview(guest as never);
    const stray = { webContents: fakeContents(electronMock.otherSession), destroy: vi.fn() };
    guest.emit("did-create-window", stray);
    expect(stray.destroy).toHaveBeenCalledOnce();
    expect(stray.webContents.setWindowOpenHandler).not.toHaveBeenCalled();
  });

  it("verifies attached webContents by session before link-owned registration", () => {
    expect(isSideBrowserContents({ session: electronMock.sideBrowserSession } as never)).toBe(true);
    expect(isSideBrowserContents({ session: electronMock.otherSession } as never)).toBe(false);
  });
});
