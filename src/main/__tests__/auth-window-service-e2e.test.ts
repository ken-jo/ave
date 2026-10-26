// Exercises the full window event path: a fast SSO close after navigation must resolve successfully.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import type { Cookie } from "electron";

useChromiumRuntime();

// Drain promise queues with repeated timer turns; the runner lacks a microtask-flush helper.
async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

class FakeEmitter {
  private _listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]) => {
      listener(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter((l) => l !== listener));
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    // Snapshot the list — a listener may call off() during iteration.
    const list = [...(this._listeners.get(event) ?? [])];
    for (const l of list) l(...args);
    return list.length > 0;
  }
}

class FakeWebContents extends FakeEmitter {
  private _currentUrl: string;
  public session: {
    cookies: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      flushStore: ReturnType<typeof vi.fn>;
    };
  };
  public isDestroyed = vi.fn(() => false);
  public setWindowOpenHandler = vi.fn();
  public openDevTools = vi.fn();
  public executeJavaScript = vi.fn().mockResolvedValue(undefined);

  constructor(initialUrl: string, cookiesForSession: Cookie[] = []) {
    super();
    this._currentUrl = initialUrl;
    this.session = {
      cookies: {
        get: vi.fn().mockResolvedValue(cookiesForSession),
        set: vi.fn().mockResolvedValue(undefined),
        flushStore: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  getURL(): string {
    return this._currentUrl;
  }

  navigateTo(url: string): void {
    this._currentUrl = url;
  }
}

// Window mocks must be constructor functions so new BrowserWindow works.
class FakeBrowserWindow extends FakeEmitter {
  public webContents: FakeWebContents;
  private _destroyed = false;

  public setMenu = vi.fn();
  public isDestroyed = vi.fn(() => this._destroyed);
  public getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1024, height: 768 }));
  public setPosition = vi.fn();
  public loadURL = vi.fn().mockResolvedValue(undefined);
  // close() is a spy so tests can assert how many times it was called. It emits "closed" exactly once (guards against double-fire).
  public close = vi.fn(() => {
    if (!this._destroyed) {
      this._destroyed = true;
      this.emit("closed");
    }
  });
  public destroy = vi.fn(() => this.close());

  constructor() {
    super();
    this.webContents = new FakeWebContents("about:blank");
  }
}

let currentFakeWindow: FakeBrowserWindow;

// Shared partition session returned by session.fromPartition in grace-collect.
const fakePartitionSession = {
  setUserAgent: vi.fn(),
  clearStorageData: vi.fn().mockResolvedValue(undefined),
  clearCache: vi.fn().mockResolvedValue(undefined),
  cookies: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    flushStore: vi.fn().mockResolvedValue(undefined),
  },
};

vi.mock("electron", () => {
  function MockBrowserWindow(_opts: unknown) {
    const win = new FakeBrowserWindow();
    currentFakeWindow = win;
    return win;
  }

  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    session: {
      fromPartition: vi.fn().mockReturnValue(fakePartitionSession),
    },
    shell: { openExternal: vi.fn() },
    app: { getVersion: () => "0.14.1" },
    ipcMain: {},
  };
});

vi.mock("../window-chrome.js", () => ({
  getCommonChromeOptions: vi.fn(() => ({})),
}));
vi.mock("../../ipc/domains/window.js", () => ({
  registerWindowEventListeners: vi.fn(),
}));
vi.mock("../../ipc/window-control-registry.js", () => ({
  markAsWindowControlOwned: vi.fn(),
}));
vi.mock("../auth-window-registry.js", () => ({
  markAsAuthOwned: vi.fn(),
}));
vi.mock("../window-titlebar-shell.js", () => ({
  buildTitlebarCss: vi.fn(() => ""),
  buildTitlebarHtml: vi.fn(() => ""),
  buildTitlebarButtonScript: vi.fn(() => ""),
}));
vi.mock("../app-icon.js", () => ({
  resolveAppIconPath: vi.fn(() => undefined),
}));
vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const { openAuthWindow, wirePluginAuthPartitionPersistence, RETAINED_SESSION_COOKIE_TTL_SECONDS } =
  await import("../auth-window-service.js");
const { buildPersistentBrowserUserAgent } = await import("../browser-user-agent.js");

wirePluginAuthPartitionPersistence({
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn(),
});

const COMPLETION_URL = "https://portal.example.com/auth/callback";
const COMPLETION_PATTERN = "portal.example.com/auth/callback";
const COOKIE_HOST = "portal.example.com";
const SESSION_COOKIE: Cookie = {
  name: "session",
  value: "abc123",
  domain: ".portal.example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  session: false,
  hostOnly: false,
  sameSite: "unspecified",
};

function makeParentWindow(): FakeBrowserWindow {
  return new FakeBrowserWindow();
}

beforeEach(() => {
  vi.clearAllMocks();
  fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
});

afterEach(() => {
  vi.useRealTimers();
});

// Suspend cookies.get so close races with collection; the partition grace path must win without rejecting.
describe("openAuthWindow — fast-SSO race: closed fires while checkAndCollect is in-flight", () => {
  it("resolves with cookies when closed arrives while the webview cookie fetch is still pending", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    // Suspend webview collection to race the close handler against the partition grace path.
    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    // Handle rejection before firing events so a failing assertion cannot leak an unhandled promise.
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);
    expect(fakePartitionSession.setUserAgent).toHaveBeenCalledWith(buildPersistentBrowserUserAgent());

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise); // hangs
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Do not flush: cookies.get must remain suspended when closed fires; committed navigation already permits grace collection.
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    await flushAsync();

    // Webview cookies resolve now (late) — settled=true so finish() is a no-op.
    resolveWebviewCookies([]);
    await flushAsync();

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies.length).toBeGreaterThan(0);
      expect(cookies[0].name).toBe("session");
      expect(cookies[0].value).toBe("abc123");
    }
  });

  it("resolves with OpenAuthWindowResult envelope when returnFinalUrl is true", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
      returnFinalUrl: true,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // closed fires while checkAndCollect is suspended.
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    await flushAsync();
    resolveWebviewCookies([]);
    await flushAsync();

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toHaveProperty("cookies");
      expect(outcome.value).toHaveProperty("finalUrl");
      const envelope = outcome.value as import("../auth-window-service.js").OpenAuthWindowResult;
      expect(envelope.finalUrl).toBe(COMPLETION_URL);
      expect(envelope.cookies[0].name).toBe("session");
    }
  });
});

describe("openAuthWindow — grace-collect path (closed fires before checkAndCollect)", () => {
  it("resolves via grace-collect when window closes while webview cookie fetch is in flight", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });

    await flushAsync();

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    resolveWebviewCookies([]);
    await flushAsync();

    const result = await resultPromise;
    const cookies = result as import("../auth-window-service.js").AuthCookie[];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies[0].name).toBe("session");
  });

  it("rejects when window closes before webview attaches (no grace-collect possible)", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("window closed before login completed");
  });

  it("rejects when window closes after webview attaches but before navigating to a completion URL", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    const fakeWv = new FakeWebContents("https://sso.example.com/login");
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.emit("did-navigate", {}, "https://sso.example.com/login");

    await flushAsync();

    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("window closed before login completed");
  });

  it("rejects when the grace-collect cookie fetch itself fails — error is not suppressed", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockRejectedValue(new Error("webview session destroyed"));
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    fakePartitionSession.cookies.get.mockRejectedValue(new Error("partition gone"));

    await flushAsync();
    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
  });
});

// The close event emitted by finish must observe settled=true and cannot produce a second outcome.
describe("openAuthWindow — settled/finish() mutual-exclusion guard", () => {
  it("resolves correctly when checkAndCollect calls close() which cascades a closed event", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);

    // Emit closed synchronously from close() to exercise the settled guard.
    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    await flushAsync();

    const outcome = await outcomePromise;

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies[0].name).toBe("session");
    }
  });

  it("does not reject when closed fires after checkAndCollect already resolved (guard makes closed a no-op)", async () => {
    // Complete the suspended collector after grace collection to prove late finish is a no-op.
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);

    // Webview attaches with hanging cookies.get — checkAndCollect suspends.
    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Grace-collect fires and resolves (settled=true after this).
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");
    await flushAsync();

    // Late checkAndCollect completion — must be a no-op (settled=true).
    resolveWebviewCookies([SESSION_COOKIE]);
    await flushAsync();

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies[0].name).toBe("session");
    }
  });
});

// Session cookies need write-back and flush to survive restart; retained values must remain host-only without fabricated expiry.
describe("openAuthWindow — retainCookies makes the harvested session survive a restart", () => {
  const VAULT_PARTITION = "persist:plugin-auth:sample:portal";
  // Same cookie the other suites use — it carries no expirationDate.
  const RESTART_SESSION_COOKIE: Cookie = { ...SESSION_COOKIE, session: true };
  const BOUNDED_COOKIE: Cookie = { ...SESSION_COOKIE, name: "bounded", expirationDate: 1_900_000_000 };

  function expectBoundedExpiry(details: Record<string, unknown>, startedAtMs: number): void {
    const nowSec = Math.floor(startedAtMs / 1000);
    expect(typeof details.expirationDate).toBe("number");
    expect(details.expirationDate as number).toBeGreaterThanOrEqual(nowSec + RETAINED_SESSION_COOKIE_TTL_SECONDS);
    expect(details.expirationDate as number).toBeLessThanOrEqual(nowSec + RETAINED_SESSION_COOKIE_TTL_SECONDS + 5);
  }

  async function loginThroughWebview(
    fakeWv: FakeWebContents,
    opts: { retainCookies?: boolean; persistPartition?: string } = { retainCookies: true },
  ) {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;
    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      persistPartition: VAULT_PARTITION,
      timeoutMs: 10_000,
      ...opts,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
    await flushAsync(1);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);
    await flushAsync();
    return outcomePromise;
  }

  it.each([
    ["plugin-auth:sample", false], ["plugin-auth:sample", true],
    [VAULT_PARTITION, false], [VAULT_PARTITION, true],
  ] as const)("delivers cookies to the consumer and preserves %s with retention=%s", async (partition, retainCookies) => {
    const { partitionCookieHeaderForUrl } = await import("../auth-partition-cookie-jar.js");
    fakePartitionSession.clearStorageData.mockClear();
    fakePartitionSession.clearCache.mockClear();
    const startedAt = Date.now();
    const guest = new FakeWebContents(COMPLETION_URL, [RESTART_SESSION_COOKIE]);
    const outcome = await loginThroughWebview(guest, { persistPartition: partition, retainCookies });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toEqual([expect.objectContaining({ name: "session", value: retainCookies ? "" : "abc123" })]);
    expect(currentFakeWindow.isDestroyed()).toBe(true);
    expect(fakePartitionSession.clearStorageData).not.toHaveBeenCalled();
    expect(fakePartitionSession.clearCache).not.toHaveBeenCalled();
    expect(await partitionCookieHeaderForUrl(guest.session as unknown as import("electron").Session, new URL(COMPLETION_URL))).toBe("session=abc123");
    if (retainCookies) expectBoundedExpiry(guest.session.cookies.set.mock.calls[0][0], startedAt);
    else expect(guest.session.cookies.set).not.toHaveBeenCalled();
  });

  it("re-sets the session cookie into the partition with a bounded expiry and flushes; the plugin sees neither the value nor the expiry", async () => {
    const startedAt = Date.now();
    const fakeWv = new FakeWebContents(COMPLETION_URL, [RESTART_SESSION_COOKIE]);

    const outcome = await loginThroughWebview(fakeWv);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(cookies).toHaveLength(1);
      expect(cookies[0].name).toBe("session");
      expect(cookies[0].value).toBe("");
      expect(cookies[0].expirationDate).toBeUndefined();
    }

    const { set, flushStore } = fakeWv.session.cookies;
    expect(set).toHaveBeenCalledTimes(1);
    const details = set.mock.calls[0][0] as Record<string, unknown>;
    expect(details).toMatchObject({
      url: "https://portal.example.com/",
      name: "session",
      value: "abc123",
      domain: ".portal.example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "unspecified",
    });
    expectBoundedExpiry(details, startedAt);
    expect(flushStore).toHaveBeenCalledTimes(1);
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(flushStore.mock.invocationCallOrder[0]);
  });

  it("leaves a cookie the upstream service already bounded untouched and does not flush for nothing", async () => {
    const fakeWv = new FakeWebContents(COMPLETION_URL, [BOUNDED_COOKIE]);

    const outcome = await loginThroughWebview(fakeWv);

    expect(outcome.ok).toBe(true);
    expect(fakeWv.session.cookies.set).not.toHaveBeenCalled();
    expect(fakeWv.session.cookies.flushStore).not.toHaveBeenCalled();
  });

  it("writes nothing back when vault mode is off — the plugin receives the values and owns persistence", async () => {
    const fakeWv = new FakeWebContents(COMPLETION_URL, [RESTART_SESSION_COOKIE]);

    const outcome = await loginThroughWebview(fakeWv, {});

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(cookies[0].value).toBe("abc123");
    }
    expect(fakeWv.session.cookies.set).not.toHaveBeenCalled();
    expect(fakeWv.session.cookies.flushStore).not.toHaveBeenCalled();
  });

  it("a failed write-back does not turn a successful login into a failed one", async () => {
    // A persistence failure must not reject a live authenticated session.
    const fakeWv = new FakeWebContents(COMPLETION_URL, [RESTART_SESSION_COOKIE]);
    fakeWv.session.cookies.set.mockRejectedValueOnce(new Error("cookie store locked"));

    const outcome = await loginThroughWebview(fakeWv);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(cookies[0].name).toBe("session");
    }
    expect(fakeWv.session.cookies.flushStore).not.toHaveBeenCalled();
  });

  it("also makes the session durable on the closed-event grace path", async () => {
    const startedAt = Date.now();
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;
    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      persistPartition: VAULT_PARTITION,
      retainCookies: true,
      timeoutMs: 10_000,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
    await flushAsync(1);

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    fakePartitionSession.cookies.get.mockResolvedValue([RESTART_SESSION_COOKIE]);
    currentFakeWindow.emit("closed");
    await flushAsync();
    resolveWebviewCookies([]);
    await flushAsync();

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    expect(fakePartitionSession.cookies.set).toHaveBeenCalledTimes(1);
    const details = fakePartitionSession.cookies.set.mock.calls[0][0] as Record<string, unknown>;
    expect(details).toMatchObject({ name: "session", value: "abc123", domain: ".portal.example.com" });
    expectBoundedExpiry(details, startedAt);
    expect(fakePartitionSession.cookies.flushStore).toHaveBeenCalledTimes(1);
    // The webview-side jar was never written — grace path owns the harvest.
    expect(fakeWv.session.cookies.set).not.toHaveBeenCalled();
  });
});
