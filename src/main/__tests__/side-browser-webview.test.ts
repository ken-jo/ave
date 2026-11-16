import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import { afterQueuedCallbacks } from "../../__tests__/support/deferred.js";
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
  app: { getVersion: () => "0.14.1", getPath: () => "/Users/me/Downloads" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) },
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
  registerBrowserDownloadAllowance: vi.fn(),
  reportBrowserWorkspaceBlockedDownload: vi.fn(),
}));

// A check of one path that fails with a filesystem error, as an unreadable or vanished staging folder makes it fail.
const fsFault = vi.hoisted(() => ({ path: undefined as string | undefined, code: "EACCES" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (path: unknown) => {
    if (fsFault.path !== undefined && String(path) === fsFault.path) throw Object.assign(new Error(`${fsFault.code}: simulated`), { code: fsFault.code });
  };
  return {
    ...actual,
    openSync: (path: string, ...rest: unknown[]) => { fail(path); return (actual.openSync as (...args: unknown[]) => number)(path, ...rest); },
    lstatSync: (path: string, ...rest: unknown[]) => { fail(path); return (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest); },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fsFault.path = undefined;
});

const {
  DOWNLOAD_PROMPTS_PER_ORIGIN,
  DOWNLOAD_RATE_WINDOW_MS,
  UNANSWERED_DOWNLOADS,
  attachSideBrowserWebview,
  configureSideBrowserWebviewAttach,
  createSideBrowserDownloadPolicy,
  installSideBrowserPartitionPolicy,
  isSideBrowserContents,
  isSideBrowserPopupUrlAllowed,
} = await import("../side-browser-webview.js");
const { buildPersistentBrowserUserAgent } = await import("../browser-user-agent.js");
const { BrowserDownloadStagingError } = await import("../browser/browser-download-staging.js");
const { resolve: resolvePath } = await import("node:path");
// The checkout's resources folder, where the native download file helper for this platform is built (test:prepare).
const RESOURCES = resolvePath("resources");

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
    await installSideBrowserPartitionPolicy(RESOURCES);

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
    await installSideBrowserPartitionPolicy(RESOURCES);
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

  it("removes staged downloads a previous run left at install, and observes each admitted download as staged", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ave-side-browser-")));
    vi.stubEnv("AVE_HOME", home);
    try {
      const leftover = join(home, "browser-downloads", "0123456789abcdef0123456789abcdef");
      mkdirSync(join(home, "browser-downloads"));
      writeFileSync(leftover, "left by a crash");
      await installSideBrowserPartitionPolicy(RESOURCES);
      expect(existsSync(leftover)).toBe(false);
      const download = electronMock.sideBrowserSession.on.mock.calls.find(([name]) => name === "will-download")![1];
      const contents = { id: 71, getURL: () => "https://site.example/", isDestroyed: () => false, hostWebContents: null };
      const item = { getURL: () => "https://site.example/report", getURLChain: () => ["https://site.example/report"], getFilename: () => "report",
        setSavePath: vi.fn(), pause: vi.fn(), resume: vi.fn(), on: vi.fn(), once: vi.fn(), getState: () => "progressing", cancel: vi.fn() };
      const first = event();
      download(first, item, contents);
      expect(first.preventDefault).not.toHaveBeenCalled();
      expect(item.setSavePath).toHaveBeenCalledWith(expect.stringMatching(/browser-downloads[/\\][0-9a-f]{32}$/));
      expect(item.pause).toHaveBeenCalledOnce();
      expect(workspace.observeDownload).toHaveBeenCalledWith(contents, expect.objectContaining({ getSavePath: expect.any(Function) }));
      expect(workspace.observeDownload.mock.calls[0]?.[1]).not.toBe(item);
      // Its Save dialog is the system's; closing it cancels the download.
      await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledOnce());
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("a staging folder that cannot be verified", () => {
    const withHome = async (run: (home: string) => Promise<void> | void) => {
      const { mkdtempSync, rmSync, realpathSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const home = realpathSync(mkdtempSync(join(tmpdir(), "ave-side-browser-")));
      vi.stubEnv("AVE_HOME", home);
      try {
        await run(home);
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    };
    // Deliver one will-download and report what the page was told: the handler must refuse it with a notice and throw nothing.
    const download = async () => {
      const { reportBrowserWorkspaceBlockedDownload } = await import("../browser/browser-workspace-desktop.js");
      const registered = electronMock.sideBrowserSession.on.mock.calls.find(([name]) => name === "will-download");
      if (registered === undefined) throw new Error("no will-download handler was installed");
      const handler = registered[1];
      const contents = { id: 72, getURL: () => "https://site.example/", isDestroyed: () => false, hostWebContents: null };
      const item = { getURL: () => "https://site.example/report", getURLChain: () => ["https://site.example/report"], getFilename: () => "report",
        setSavePath: vi.fn(), pause: vi.fn(), resume: vi.fn(), on: vi.fn(), once: vi.fn(), getState: () => "progressing", cancel: vi.fn() };
      const willDownload = event();
      expect(() => handler(willDownload, item, contents)).not.toThrow();
      expect(willDownload.preventDefault).toHaveBeenCalledOnce();
      expect(item.setSavePath).not.toHaveBeenCalled();
      expect(reportBrowserWorkspaceBlockedDownload).toHaveBeenLastCalledWith(72, "report", ["https://site.example/report"], "staging");
      expect(workspace.observeDownload).not.toHaveBeenCalled();
    };

    it("refuses downloads with the staging notice when the folder is unreadable at start, instead of failing the install", async () => {
      await withHome(async (home) => {
        const { join } = await import("node:path");
        fsFault.path = join(home, "browser-downloads");
        await expect(installSideBrowserPartitionPolicy(RESOURCES)).resolves.toBeUndefined();
        await download();
      });
    });

    it("refuses downloads with the staging notice once the folder is gone or has become a link after start", async () => {
      await withHome(async (home) => {
        const { mkdirSync, rmSync, symlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        await installSideBrowserPartitionPolicy(RESOURCES);
        const staging = join(home, "browser-downloads");
        rmSync(staging, { recursive: true });
        await download();
        const elsewhere = join(home, "elsewhere");
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, staging, process.platform === "win32" ? "junction" : "dir");
        await download();
      });
    });

    it.runIf(process.platform !== "linux")("refuses downloads with the staging notice when the native download file helper is missing", async () => {
      await withHome(async (home) => {
        const { mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const incomplete = join(home, "resources-without-helper");
        mkdirSync(incomplete);
        await expect(installSideBrowserPartitionPolicy(incomplete)).resolves.toBeUndefined();
        await download();
      });
    });

    // A helper that is present but broken: it ends with its usage, crashes, or answers its boot sweep with a line it never gives.
    it.runIf(process.platform === "darwin").each([
      ["exits 2 with its usage", "echo 'usage: ave-dir-ops --dir-rename|--dir-copy|--dir-remove|--dir-sweep <arguments>' >&2\nexit 2"],
      ["is killed by SIGSEGV", "echo ready\nkill -SEGV $$"],
      ["exits 0 with a line it never gives", "echo ready\necho 'swept lots'\nexit 0"],
    ])("refuses downloads with the staging notice when the native download file helper %s, instead of failing the install", async (_case, body) => {
      await withHome(async (home) => {
        const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const broken = join(home, "resources-with-broken-helper");
        const helper = join(broken, "macos-dir-ops", process.arch, "ave-dir-ops");
        mkdirSync(join(broken, "macos-dir-ops", process.arch), { recursive: true });
        writeFileSync(helper, `#!/bin/sh\n${body}\n`);
        chmodSync(helper, 0o755);
        await expect(installSideBrowserPartitionPolicy(broken)).resolves.toBeUndefined();
        await download();
      });
    });

    it("lets an error that is not a verification result fail the install, once every download is refused", async () => {
      await withHome(async (home) => {
        const { join } = await import("node:path");
        fsFault.path = join(home, "browser-downloads");
        fsFault.code = "EMFILE";
        try {
          await expect(installSideBrowserPartitionPolicy(RESOURCES)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "EMFILE" }) });
        } finally {
          fsFault.code = "EACCES";
        }
        await download();
      });
    });

    it.each(["setUserAgent", "setPermissionRequestHandler", "setPermissionCheckHandler"] as const)("surfaces an early %s failure without claiming a refusal handler exists", async (method) => {
      const failure = new Error("session setup failed");
      electronMock.sideBrowserSession[method].mockImplementationOnce(() => { throw failure; });
      const result = await import("../side-browser-webview.js");
      await expect(Promise.resolve().then(() => installSideBrowserPartitionPolicy(RESOURCES))).rejects.toBe(failure);
      expect(result).toHaveProperty("SideBrowserPolicyInstallError");
      expect(electronMock.sideBrowserSession.on).not.toHaveBeenCalled();
    });

    it("holds initialization until an unconfirmed sweep ends in refusal, and never admits staging beside it", async () => {
      await withHome(async () => {
        const staging = await import("../browser/browser-download-staging.js");
        let refuse!: (error: Error) => void;
        const sweep = vi.spyOn(staging, "sweepBrowserDownloadStaging").mockImplementationOnce(() => new Promise<number>((_resolve, reject) => { refuse = reject; }));
        const stage = vi.spyOn(staging, "stageBrowserDownload");
        try {
          let finished = false;
          const install = Promise.resolve(installSideBrowserPartitionPolicy(RESOURCES)).then(() => { finished = true; });
          await afterQueuedCallbacks();
          expect(finished).toBe(false);
          const { HeldFileHelperStalledError } = await import("../browser/browser-download-files.js");
          refuse(new BrowserDownloadStagingError("sweep termination unconfirmed", { cause: new HeldFileHelperStalledError("/helper", "did not end", true) }));
          await install;
          await download();
          expect(stage).not.toHaveBeenCalled();
          expect(sweep).toHaveBeenCalledOnce();
        } finally { sweep.mockRestore(); stage.mockRestore(); }
      });
    });
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
      return { getURL: () => url, getURLChain: () => [url], getFilename: () => "report.pdf" };
    }
    function page(id: number, url = "https://files.example.com/list") {
      return { id, getURL: () => url };
    }
    // Each staged download answers its Save dialog when the test says so, and only once its turn came.
    function policy(clock = { at: 0 }) {
      const warn = vi.fn();
      const onBlocked = vi.fn();
      const shown: number[] = [];
      const answers: Array<(saved: boolean) => void> = [];
      let next = 0;
      let refuseStaging = false;
      const stage = vi.fn((_item: unknown, _contents: unknown, turn: Promise<void>) => {
        if (refuseStaging) throw new BrowserDownloadStagingError("the download staging folder was replaced");
        const index = next++;
        const answered = turn.then(() => { shown.push(index); return new Promise<boolean>((resolve) => { answers[index] = resolve; }); });
        return { download: { index }, answered };
      });
      const handle = createSideBrowserDownloadPolicy({ now: () => clock.at, warn, onBlocked, stage: stage as never });
      return { handle, warn, clock, onBlocked, stage, shown, answer: (index: number, saved: boolean) => answers[index]?.(saved),
        refuseStaging: () => { refuseStaging = true; } };
    }
    const settled = afterQueuedCallbacks;

    it("queues a page's Save dialogs one at a time instead of refusing a download while one is open", async () => {
      const { handle, shown, answer, onBlocked } = policy();
      const first = event();
      const second = event();
      expect(handle(first, fakeItem() as never, page(1) as never)).toEqual({ index: 0 });
      expect(handle(second, fakeItem() as never, page(1) as never)).toEqual({ index: 1 });
      // Another page has its own queue.
      handle(event(), fakeItem() as never, page(2, "https://other.example.org/") as never);
      await settled();
      expect(first.preventDefault).not.toHaveBeenCalled();
      expect(second.preventDefault).not.toHaveBeenCalled();
      expect(onBlocked).not.toHaveBeenCalled();
      expect(shown).toEqual([0, 2]);
      answer(0, true);
      await settled();
      expect(shown).toEqual([0, 2, 1]);
      answer(1, true);
      await settled();
      // The queue is empty again: the next download's dialog shows at once.
      handle(event(), fakeItem() as never, page(1) as never);
      await settled();
      expect(shown).toEqual([0, 2, 1, 3]);
    });

    it("refuses a download beyond the downloads waiting for a Save dialog, and one the staging folder cannot take, each with a notice", async () => {
      const { handle, onBlocked, answer, refuseStaging, clock } = policy();
      const waiting = Array.from({ length: UNANSWERED_DOWNLOADS }, (_, index) => {
        clock.at += 1;
        // Different sites, so the per-site limit is not what refuses.
        return handle(event(), fakeItem() as never, page(10 + index, `https://site-${index}.example/`) as never);
      });
      expect(waiting.every((download) => download !== null)).toBe(true);
      const over = event();
      expect(handle(over, fakeItem() as never, page(20, "https://another.example/") as never)).toBeNull();
      expect(over.preventDefault).toHaveBeenCalledOnce();
      expect(onBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ id: 20 }), expect.objectContaining({ getFilename: expect.any(Function) }), "queue");
      // Answering one frees a place.
      await settled();
      answer(0, true);
      await settled();
      expect(handle(event(), fakeItem() as never, page(21, "https://another.example/") as never)).not.toBeNull();
      answer(1, true);
      await settled();
      refuseStaging();
      const unstaged = event();
      expect(handle(unstaged, fakeItem() as never, page(22, "https://third.example/") as never)).toBeNull();
      expect(unstaged.preventDefault).toHaveBeenCalledOnce();
      expect(onBlocked).toHaveBeenLastCalledWith(expect.objectContaining({ id: 22 }), expect.anything(), "staging");
    });

    it("does not hold saved downloads against the site, reports every refusal, and lifts the limit on request", async () => {
      const { handle, clock, onBlocked, answer } = policy();
      const site = page(1);
      // Five files saved one after another all go through.
      for (let count = 0; count < 5; count += 1) {
        handle(event(), fakeItem() as never, site as never);
        await settled();
        answer(count, true);
        await settled();
        clock.at += 100;
      }
      expect(onBlocked).not.toHaveBeenCalled();
      // Dialogs closed without saving do count; past the limit the refusal is reported with its reason.
      for (let count = 0; count < DOWNLOAD_PROMPTS_PER_ORIGIN; count += 1) {
        handle(event(), fakeItem() as never, site as never);
        await settled();
        answer(5 + count, false);
        await settled();
      }
      const refused = event();
      expect(handle(refused, fakeItem() as never, site as never)).toBeNull();
      expect(refused.preventDefault).toHaveBeenCalledOnce();
      expect(onBlocked).toHaveBeenLastCalledWith(site, expect.objectContaining({ getFilename: expect.any(Function) }), "rate");
      handle.allowOrigin("https://files.example.com");
      const again = event();
      handle(again, fakeItem() as never, site as never);
      expect(again.preventDefault).not.toHaveBeenCalled();
    });

    it("never opens a saved file and never picks the final path itself", async () => {
      const { readFileSync } = await import("node:fs");
      for (const module of ["../side-browser-webview.ts", "../browser/browser-download-staging.ts"]) {
        const source = readFileSync(new URL(module, import.meta.url), "utf8");
        expect(source).not.toMatch(/\bshell\b|openPath|openExternal/);
      }
      // The only path set on an item is a staging file; the final path comes from the Save dialog.
      const staging = readFileSync(new URL("../browser/browser-download-staging.ts", import.meta.url), "utf8");
      expect(staging.match(/setSavePath\(/g)).toHaveLength(1);
      expect(staging).toContain("item.setSavePath(staged)");
    });

    it("cancels and logs download prompts beyond the per-origin rate limit", async () => {
      const { handle, warn, clock, answer } = policy();
      for (let i = 0; i < DOWNLOAD_PROMPTS_PER_ORIGIN; i += 1) {
        const allowed = event();
        handle(allowed, fakeItem() as never, page(1) as never);
        expect(allowed.preventDefault).not.toHaveBeenCalled();
        await settled();
        answer(i, false);
        await settled();
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
