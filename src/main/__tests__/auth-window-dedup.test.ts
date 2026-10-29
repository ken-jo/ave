// Concurrent visible logins share one window per partition/title; silent warmups remain independent.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import { shell, session, type Cookie } from "electron";
import { t } from "../../i18n/index.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
import { SYSTEM_BROWSER_OAUTH_ENDPOINTS } from "../oauth-browser-policy.js";
import { AuthRedirectCatchers } from "../auth-redirect-catcher.js";
import { createLogger } from "../../lib/logger.js";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

useChromiumRuntime();

class FakeEmitter {
  private _listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  on(event: string, listener: (...a: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
    return this;
  }
  off(event: string, listener: (...a: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter((l) => l !== listener));
    return this;
  }
  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]) => { this.off(event, wrapper); listener(...args); };
    return this.on(event, wrapper);
  }
  emit(event: string, ...args: unknown[]): boolean {
    const list = [...(this._listeners.get(event) ?? [])];
    for (const l of list) l(...args);
    return list.length > 0;
  }
}

class FakeWebContents extends FakeEmitter {
  public session = { cookies: { get: vi.fn().mockResolvedValue([]) } };
  public isDestroyed = vi.fn(() => false);
  public setWindowOpenHandler = vi.fn();
  public openDevTools = vi.fn();
  public executeJavaScript = vi.fn().mockResolvedValue(undefined);
  public preferences: Record<string, unknown> = {};
  public close = vi.fn(() => { this.isDestroyed.mockReturnValue(true); this.emit("destroyed"); });
  private _url = "about:blank";
  getURL(): string { return this._url; }
}

class FakeBrowserWindow extends FakeEmitter {
  public options: Record<string, unknown> = {};
  public webContents = new FakeWebContents();
  private _destroyed = false;
  private _minimized = false;
  public setMenu = vi.fn();
  public setTitleBarOverlay = vi.fn();
  public isDestroyed = vi.fn(() => this._destroyed);
  public isMinimized = vi.fn(() => this._minimized);
  public restore = vi.fn(() => { this._minimized = false; });
  public focus = vi.fn();
  public getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1024, height: 768 }));
  public getContentBounds = this.getBounds;
  public views: Array<{ webContents: FakeWebContents; setBounds: ReturnType<typeof vi.fn> }> = [];
  public contentView = { addChildView: (view: FakeBrowserWindow["views"][number]) => this.views.push(view) };
  public setPosition = vi.fn();
  public loadURL = vi.fn(async (_url: string) => undefined);
  public close = vi.fn(() => {
    if (!this._destroyed) { this._destroyed = true; this.emit("closed"); }
  });
  public destroy = vi.fn(() => this.close());
}

let constructed: FakeBrowserWindow[] = [];

vi.mock("electron", () => {
  function MockBrowserWindow(opts: Record<string, unknown>) {
    const win = new FakeBrowserWindow();
    win.options = opts;
    constructed.push(win);
    return win;
  }
  return {
    BrowserWindow: MockBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), off: vi.fn() },
    WebContentsView: class {
      webContents = new FakeWebContents();
      setBounds = vi.fn();
      constructor(options: { webPreferences?: Record<string, unknown>; webContents?: FakeWebContents }) {
        if (options.webContents) this.webContents = options.webContents;
        else if (options.webPreferences) {
          this.webContents.preferences = options.webPreferences;
          this.webContents.session = options.webPreferences.session as FakeWebContents["session"];
        }
      }
    },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
    session: { fromPartition: vi.fn().mockReturnValue({
      cookies: { get: vi.fn().mockResolvedValue([]) },
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      clearAuthCache: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
    }) },
    shell: { openExternal: vi.fn() },
    dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
    app: { getVersion: () => "0.14.1" },
    ipcMain: {},
  };
});

vi.mock("../window-chrome.js", () => ({ getCommonChromeOptions: vi.fn(() => ({})) }));
vi.mock("../../ipc/domains/window.js", () => ({ registerWindowEventListeners: vi.fn() }));
vi.mock("../../ipc/window-control-registry.js", () => ({ markAsWindowControlOwned: vi.fn() }));
vi.mock("../auth-window-registry.js", () => ({ markAsAuthOwned: vi.fn() }));
vi.mock("../app-icon.js", () => ({ resolveAppIconPath: vi.fn(() => undefined) }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const { openAuthWindow, openOAuthInAuthWindow, wirePluginAuthPartitionPersistence } = await import("../auth-window-service.js");
const { buildPersistentBrowserUserAgent } = await import("../browser-user-agent.js");
// Other modules on the import path create loggers too; pick the auth window's by name.
const authWindowLogger = () => vi.mocked(createLogger).mock.results[vi.mocked(createLogger).mock.calls.findIndex(([name]) => name === "auth-window")].value;

wirePluginAuthPartitionPersistence({
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn(),
});

const PARTITION = "persist:plugin-auth:sampleportal";
const COMPLETION = "portal.example.com/auth/callback";
const COOKIE_HOST = "portal.example.com";

async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

function parent(): import("electron").BrowserWindow {
  return new FakeBrowserWindow() as unknown as import("electron").BrowserWindow;
}

beforeEach(() => {
  constructed = [];
  vi.mocked(shell.openExternal).mockClear();
});

describe("host OAuth auth window", () => {
  it.each([false, true])("completes a resource login with refusal=%s through the production entry, same catcher and proof key", async refusal => {
    const { McpOAuthSession } = await import("../../mcp/mcp-oauth.js");
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let base = "";
    let authorization: URL | undefined;
    let proofVerified = false;
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", base).pathname;
      const json = (body: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["tools"] });
      } else if (pathname === "/.well-known/oauth-authorization-server") {
        json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      } else if (pathname === "/token") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const grant = new URLSearchParams(body);
        proofVerified = createHash("sha256").update(grant.get("code_verifier")!).digest("base64url") === authorization!.searchParams.get("code_challenge");
        json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const values = new Map<string, string>();
    const login = new McpOAuthSession({ id: "window-fixture", transport: "http", url: `${base}/mcp`, auth: "oauth",
      allowPrivateNetworks: true, oauth: { clientId: "fixture-client", clientRegistration: "preregistration" } }, {
      networkFetch: fetch, redirectCatchers: new AuthRedirectCatchers(),
      secrets: { canStoreEncrypted: () => true, getSecret: key => values.get(key) ?? null,
        setSecret: async (key, value) => { values.set(key, value); }, deleteSecret: async key => { values.delete(key); } },
      openAuthorizationUrl: async (url, options) => {
        authorization = new URL(url);
        const shown = openOAuthInAuthWindow(parent(), url, options);
        expect(constructed).toHaveLength(1);
        const guest = new FakeWebContents();
        constructed[0].webContents.emit("did-attach-webview", {}, guest);
        const preventDefault = vi.fn();
        guest.emit("will-redirect", { url: "https://accounts.google.com/o/oauth2/v2/auth", preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
        if (refusal) {
          guest.emit("will-redirect", { url: "https://accounts.google.com/signin/oauth/error?authError=ZGlzYWxsb3dlZF91c2VyYWdlbnQ", preventDefault });
          await flush(1);
          expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(url);
          expect(constructed[0].isDestroyed()).toBe(true);
        }
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        expect(callback.hostname).toBe("127.0.0.1");
        expect(Number(callback.port)).toBeGreaterThan(0);
        if (!refusal) {
          for (const path of ["/unrelated?x=1", "/?code=forged&state=wrong"]) {
            expect((await fetch(new URL(path, callback), { redirect: "manual" })).status).toBe(404);
            await flush(1);
            expect(constructed[0].isDestroyed()).toBe(false);
            expect(proofVerified).toBe(false);
          }
        }
        callback.search = new URLSearchParams({ code: "fixture-code", state: authorization.searchParams.get("state")! }).toString();
        await fetch(callback, { redirect: "manual" });
        await shown;
      },
    });
    try {
      await login.authenticate();
      expect(login.getStatus()).toBe("authenticated");
      expect(proofVerified).toBe(true);
      expect(constructed[0].isDestroyed()).toBe(true);
    } finally {
      login.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("completes plan sign-in through the production window entry and a real state-checked catcher", async () => {
    const { ChatGptPlanSession } = await import("../chatgpt-plan/session.js");
    const { startChatGptPlanCallbackListener } = await import("../chatgpt-plan/loopback.js");
    const endpoints = await import("../chatgpt-plan/endpoints.js");
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const values = new Map<string, string>();
    let params: URLSearchParams | undefined;
    let proofVerified = false;
    let windowCompletion: Promise<void> | undefined;
    // The session opens the window detached; keep the client's own failure so it is reported instead of "sign-in-failed".
    let clientError: unknown;
    // The token exchange waits until the client has read the callback's 200, so completion cannot close the listener mid-read.
    let callbackRead!: () => void;
    const callbackAnswered = new Promise<void>(resolve => { callbackRead = resolve; });
    const login = new ChatGptPlanSession({
      secrets: { isSecretStorageEncrypted: () => true, getEncryptedSecret: key => values.get(key) ?? null,
        setSecret: async (key, value) => { values.set(key, value); }, deleteSecret: async key => { values.delete(key); } },
      hostId: async () => "urn:uuid:6bdc3791-aab4-4ce0-b8ad-36a5950d279c",
      startListener: startChatGptPlanCallbackListener,
      verifier: { verify: async () => ({ issuer: endpoints.CHATGPT_PLAN_ISSUER, subject: "fixture-subject", email: null }) },
      fetch: (async (input, init) => {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (String(input) === endpoints.CHATGPT_PLAN_TOKEN_URL) {
          await callbackAnswered;
          proofVerified = createHash("sha256").update(body.get("code_verifier")!).digest("base64url") === params!.get("code_challenge");
          return new Response(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id",
            token_type: "Bearer", expires_in: 3600, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke" }), { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ issuer: endpoints.CHATGPT_PLAN_ISSUER, authorization_endpoint: endpoints.CHATGPT_PLAN_AUTHORIZE_URL,
          token_endpoint: endpoints.CHATGPT_PLAN_TOKEN_URL, jwks_uri: endpoints.CHATGPT_PLAN_JWKS_URL,
          revocation_endpoint: endpoints.CHATGPT_PLAN_REVOCATION_URL }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      openAuthorizationUrl: async (url, options) => {
        try {
          params = new URL(url).searchParams;
          windowCompletion = openOAuthInAuthWindow(parent(), url, options);
          const callback = new URL(params.get("redirect_uri")!);
          callback.search = "code=forged&state=wrong&client_id=fixture-client";
          const forged = await fetch(callback);
          await forged.text();
          expect(forged.status).toBe(404);
          expect(proofVerified).toBe(false);
          callback.search = new URLSearchParams({ code: "fixture-code", state: params.get("state")!, client_id: "fixture-client" }).toString();
          const answered = await fetch(callback);
          await answered.text();
          expect(answered.status).toBe(200);
        } catch (error) {
          clientError = error;
          throw error;
        } finally { callbackRead(); }
        await windowCompletion;
      },
    });
    const { completion } = await login.startSignIn();
    try {
      await completion.catch(error => { throw clientError ?? error; });
      await windowCompletion;
      expect(proofVerified).toBe(true);
      expect(login.status().connection).toBe("connected");
      expect(constructed[0].isDestroyed()).toBe(true);
    } finally { await login.cancelSignIn(); }
  });

  function popupContents(popup: FakeBrowserWindow): FakeWebContents {
    return popup.views[0]?.webContents ?? popup.webContents;
  }

  function openPopup(source: FakeWebContents, url = "https://identity.example.test/login"): FakeBrowserWindow {
    const decision = source.setWindowOpenHandler.mock.calls.at(-1)![0]({ url });
    expect(decision.action).toBe("allow");
    if (decision.createWindow) {
      const supplied = new FakeWebContents();
      supplied.preferences = decision.overrideBrowserWindowOptions.webPreferences;
      supplied.session = decision.overrideBrowserWindowOptions.webPreferences.session;
      const contents = decision.createWindow({ ...decision.overrideBrowserWindowOptions, webContents: supplied });
      expect(contents).toBe(supplied);
      const popup = constructed.at(-1)!;
      expect(popup.options).toMatchObject({ titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden" });
      expect(popup.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 36, width: 1024, height: 732 });
      expect(popupContents(popup)).toBe(contents);
      return popup;
    }
    const popup = new FakeBrowserWindow();
    popup.options = decision.overrideBrowserWindowOptions;
    popup.webContents.session = decision.overrideBrowserWindowOptions.webPreferences.session;
    source.emit("did-create-window", popup, { url });
    return popup;
  }

  function shellState(win: FakeBrowserWindow) {
    const html = decodeURIComponent(win.loadURL.mock.calls.at(-1)![0]);
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const uriListeners = new Map<string, (event: Record<string, unknown>) => void>();
    const uri = { title: "", addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => uriListeners.set(name, callback) };
    const parts = { "oauth-domain": { textContent: "" }, "oauth-status": { textContent: "" } };
    const security = { title: "", innerHTML: "", setAttribute: vi.fn(), dataset: { security: "" } };
    const view = { setAttribute: vi.fn(), addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => listeners.set(name, callback) };
    const context = {
      URL,
      document: { title: "", getElementById: (id: string) => ({ "auth-view": view, "oauth-uri": uri, "oauth-security": security, ...parts })[id] },
    };
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
    return { uri, security, listeners, context, parts, uriListeners };
  }

  describe.each(["oauth", "cookie"] as const)("shared %s window", lane => {
    function start() {
      let complete!: () => void;
      const completion = new Promise<void>(resolve => { complete = resolve; });
      const pending = lane === "oauth"
        ? openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", { completion, onCancel: vi.fn(), timeoutMs: 10_000 })
        : openAuthWindow(parent(), { url: "https://auth.example.test/authorize", completionUrlPatterns: [COMPLETION], cookieHosts: [COOKIE_HOST], persistPartition: "plugin-auth:sampleportal" });
      return { pending, finish: async () => { complete(); constructed[0].close(); await pending.catch(() => undefined); } };
    }

    it("keeps the visible document identity through starts, redirects, aborts and subframe failures", async () => {
      const attempt = start();
      try {
        const { uri, security, listeners } = shellState(constructed[0]);
        expect(uri.title).toBe("https://auth.example.test/authorize");
        expect(security.dataset.security).toBe("https");
        const committed = "http://identity.example.test/login";
        listeners.get("did-navigate")!({ url: committed, isMainFrame: true });
        for (const name of ["did-start-navigation", "did-redirect-navigation"]) {
          listeners.get(name)?.({ url: "https://trusted.example.test/", isMainFrame: true });
          expect(uri.title).toBe(committed);
          expect(security.dataset.security).toBe("http");
        }
        for (const [errorCode, isMainFrame] of [[-3, true], [-105, false], [-202, false]]) {
          listeners.get("did-fail-load")!({ validatedURL: "https://trusted.example.test/", errorCode, isMainFrame });
          expect(uri.title).toBe(committed);
          expect(security.dataset.security).toBe("http");
        }
      } finally { await attempt.finish(); }
    });

    it.each(["https://auth.example.test/", "http://127.0.0.1:8123/"])("renders an accessible security icon with the domain for %s", async base => {
      const attempt = start();
      try {
        const { uri, security, listeners, parts, uriListeners } = shellState(constructed[0]);
        const url = base + "long-path/".repeat(200);
        listeners.get("did-start-navigation")!({ url: base, isMainFrame: true });
        listeners.get("did-navigate")!({ url, isMainFrame: true });
        expect(uri.title).toBe(url);
        const setData = vi.fn();
        const preventDefault = vi.fn();
        uriListeners.get("copy")!({ clipboardData: { setData }, preventDefault });
        expect(setData).toHaveBeenCalledWith("text/plain", url);
        expect(preventDefault).toHaveBeenCalled();
        expect(parts["oauth-domain"].textContent).toBe(base.startsWith("https:") ? "example.test" : "127.0.0.1");
        expect(security.innerHTML).toContain('<svg');
        expect(security.setAttribute).toHaveBeenLastCalledWith("aria-label", t(base.startsWith("https:") ? "oauthWindow.secure" : "oauthWindow.insecure"));
      } finally { await attempt.finish(); }
    });

    it.each([
      ["https://accounts.google.com/o/oauth2/authorize?client_id=fixture#signin", "google.com"],
      ["https://accounts.google.com.signin.oauth2.session-verify.attacker-example.io:8443/path", "attacker-example.io"],
      ["https://" + "a".repeat(63) + ".com:8443/path", "a".repeat(63) + ".com"],
      ["https://signin.accounts.example.co.uk:8443/path", "example.co.uk"],
      ["https://signin.accounts.example.co.uk.:8443/path", "example.co.uk"],
      ["https://signin.tenant.github.io/path", "tenant.github.io"],
      ["http://[::1]:8123/path", "[::1]"],
      ["http://127.0.0.1:8123/path", "127.0.0.1"],
      ["http://localhost:8123/path", "localhost"],
      ["https://co.uk:8443/path", "co.uk"],
      ["about:blank", "about:blank"],
    ])("shows only the domain or hostname fallback for %s", async (url, domain) => {
      const attempt = start();
      try {
        const { uri, security, listeners, parts } = shellState(constructed[0]);
        listeners.get("did-navigate")!({ url, isMainFrame: true });
        expect(uri.title).toBe(url);
        expect(parts["oauth-domain"].textContent).toBe(domain);
        expect(parts["oauth-status"].textContent).toBe(security.title);
        if (url.startsWith("http:")) expect(security.innerHTML).toContain("m12 2 10 10-10 10L2 12Z");
      } finally { await attempt.finish(); }
    });

    it.each([-202, -105])("replaces the shell identity on a main-frame error-page commit (%s)", async errorCode => {
      const attempt = start();
      try {
        const { uri, security, listeners, parts } = shellState(constructed[0]);
        listeners.get("did-navigate")!({ url: "https://identity.example.test/login", isMainFrame: true });
        const failedUrl = "https://failed.example.test/login";
        listeners.get("did-start-navigation")!({ url: failedUrl, isMainFrame: true });
        listeners.get("did-fail-load")!({ validatedURL: failedUrl, errorCode, isMainFrame: true });
        expect(uri.title).toBe(failedUrl);
        expect(security.dataset.security).toBe(errorCode === -202 ? "certificate-error" : "load-error");
        expect(security.title).toBe(t(errorCode === -202 ? "oauthWindow.certificateError" : "oauthWindow.loadError"));
        expect(security.setAttribute).toHaveBeenLastCalledWith("aria-label", security.title);
        expect(parts["oauth-status"].textContent).toBe(security.title);
        expect(security.innerHTML).toContain(errorCode === -202 ? "<circle" : "m12 3 10 18H2Z");
        listeners.get("did-navigate-in-page")!({ url: failedUrl + "#details", isMainFrame: true });
        expect(security.dataset.security).not.toBe("https");
        listeners.get("did-navigate")!({ url: "https://recovered.example.test/", isMainFrame: true });
        expect(security.dataset.security).toBe("https");
      } finally { await attempt.finish(); }
    });

    it.each([
      ["main", "certificate-error"], ["main", -202], ["main", -105],
      ["popup", "certificate-error"], ["popup", -202], ["popup", -105],
    ] as const)("replaces the %s guest identity when an error page commits (%s)", async (target, failure) => {
      const attempt = start();
      void attempt.pending.catch(() => undefined);
      try {
        const guest = new FakeWebContents();
        const win = constructed.at(-1)!;
        win.webContents.emit("did-attach-webview", {}, guest);
        const chrome = target === "popup" ? openPopup(guest) : win;
        const page = target === "popup" ? popupContents(chrome) : guest;
        const state = shellState(chrome);
        chrome.webContents.executeJavaScript.mockImplementation(async (script: string) => runInNewContext(script, state.context));
        const read = () => target === "popup" ? shellState(chrome) : state;
        const committed = "https://identity.example.test/login";
        page.emit("did-navigate", {}, committed, true);
        if (target === "main") state.listeners.get("did-navigate")!({ url: committed, isMainFrame: true });
        const failedUrl = "https://failed.example.test/login";
        page.emit("did-start-navigation", {}, failedUrl, false, true);
        // A subframe certificate or load failure must leave the main identity alone.
        const rejectSubframe = vi.fn();
        page.emit("certificate-error", { preventDefault: vi.fn() }, failedUrl, "Certificate failed", {}, rejectSubframe, false);
        page.emit("did-fail-load", {}, -202, "Certificate failed", failedUrl, false);
        page.emit("did-fail-load", {}, -105, "Name not resolved", failedUrl, false);
        expect(read().uri.title).toBe(committed);
        expect(read().security.dataset.security).toBe("https");
        if (failure === "certificate-error") {
          const rejectCertificate = vi.fn();
          page.emit("certificate-error", { preventDefault: vi.fn() }, failedUrl, "Certificate failed", {}, rejectCertificate, true);
          expect(rejectCertificate).toHaveBeenCalledWith(false);
        } else {
          page.emit("did-fail-load", {}, failure, "Navigation failed", failedUrl, true);
        }
        expect(read().uri.title, String(failure)).toBe(failedUrl);
        expect(read().security.dataset.security).toBe(failure === -105 ? "load-error" : "certificate-error");
        expect(read().security.title).toBe(t(failure === -105 ? "oauthWindow.loadError" : "oauthWindow.certificateError"));
        expect(page.executeJavaScript).not.toHaveBeenCalled();
      } finally { await attempt.finish(); }
    });

    it.each([["en", en], ["ko", ko]] as const)("ships the load-error label in %s", (_locale, catalog) => {
      expect(catalog).toHaveProperty("oauthWindow.loadError");
      expect((catalog as Record<string, string>)["oauthWindow.loadError"]).toBeTruthy();
    });

    it("renders only main-frame commits and retains document TLS state across in-page navigation", async () => {
      const url = "https://auth.example.test/authorize?state=private#fragment";
      const attempt = start();
      try {
        const { uri, security, listeners } = shellState(constructed[0]);
        listeners.get("did-navigate")!({ url, isMainFrame: true });
        expect(uri.title).toBe(url);
        expect(security.title).toBe(t("oauthWindow.secure"));
        listeners.get("did-fail-load")!({ validatedURL: url, errorCode: -202, isMainFrame: true });
        expect(security.title).toBe(t("oauthWindow.certificateError"));
        listeners.get("did-navigate-in-page")!({ url: url + "next", isMainFrame: true });
        expect(uri.title).toBe(url + "next");
        expect(security.dataset.security).toBe("certificate-error");
        listeners.get("did-navigate")!({ url: "https://other.example.test", isMainFrame: false });
        expect(security.dataset.security).toBe("certificate-error");
        listeners.get("did-navigate")!({ url: "http://identity.example.test", isMainFrame: true });
        expect(security.dataset.security).toBe("http");
      } finally { await attempt.finish(); }
    });

    it.each(["main", "popup"])("tracks certificate events and committed identity for the %s guest", async target => {
      const attempt = start();
      try {
        const guest = new FakeWebContents();
        const win = constructed[0];
        win.webContents.emit("did-attach-webview", {}, guest);
        const chrome = target === "popup" ? openPopup(guest) : win;
        const page = target === "popup" ? popupContents(chrome) : guest;
        const state = shellState(chrome);
        chrome.webContents.executeJavaScript.mockImplementation(async (script: string) => runInNewContext(script, state.context));
        const read = () => target === "popup" ? shellState(chrome) : state;
        const commit = (url: string, inPage = false) => {
          page.emit(inPage ? "did-navigate-in-page" : "did-navigate", {}, url, true);
          if (target === "main") state.listeners.get(inPage ? "did-navigate-in-page" : "did-navigate")!({ url, isMainFrame: true });
        };
        const committed = "https://identity.example.test/login#initial";
        commit(committed);
        expect(read().security.dataset.security).toBe("https");
        page.emit("did-start-navigation", {}, "https://trusted.example.test/", false, true);
        page.emit("did-fail-provisional-load", {}, -202, "Certificate failed", "https://trusted.example.test/", true);
        expect(read().uri.title).toBe(committed);
        expect(read().security.dataset.security).toBe("https");
        page.emit("did-redirect-navigation", {}, "https://trusted.example.test/next", false, true);
        page.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://trusted.example.test/next", true);
        expect(read().uri.title).toBe(committed);
        expect(read().security.dataset.security).toBe("https");
        const rejectCertificate = vi.fn();
        page.emit("certificate-error", { preventDefault: vi.fn() }, committed.split("#", 1)[0], "Certificate failed", {}, rejectCertificate, true);
        await flush(1);
        expect(rejectCertificate).toHaveBeenCalledWith(false);
        expect(read().uri.title).toBe(committed.split("#", 1)[0]);
        expect(read().security.dataset.security).toBe("certificate-error");
        commit(committed);
        expect(read().uri.title).toBe(committed);
        expect(read().security.dataset.security).toBe("certificate-error");
        commit(committed + "#step", true);
        expect(read().uri.title).toBe(committed + "#step");
        expect(read().security.dataset.security).toBe("certificate-error");
        commit("http://identity.example.test/login");
        expect(read().security.dataset.security).toBe("http");
        expect(page.executeJavaScript).not.toHaveBeenCalled();
      } finally { await attempt.finish(); }
    });

    it("installs default-deny permission handlers before any load and leaves cookie storage untouched", async () => {
      const ses = session.fromPartition("unused");
      for (const method of [ses.setPermissionRequestHandler, ses.setPermissionCheckHandler, ses.setDevicePermissionHandler, ses.clearStorageData]) vi.mocked(method).mockClear();
      const attempt = start();
      try {
        const loadOrder = constructed[0].loadURL.mock.invocationCallOrder[0];
        for (const install of [ses.setPermissionRequestHandler, ses.setPermissionCheckHandler, ses.setDevicePermissionHandler]) {
          expect(install).toHaveBeenCalledOnce();
          expect(vi.mocked(install).mock.invocationCallOrder[0]).toBeLessThan(loadOrder);
        }
        const request = vi.mocked(ses.setPermissionRequestHandler).mock.calls[0][0]!;
        const check = vi.mocked(ses.setPermissionCheckHandler).mock.calls[0][0]!;
        for (const permission of ["media", "geolocation", "notifications", "fullscreen", "midi", "midiSysex", "hid", "serial", "usb", "clipboard-read", "clipboard-sanitized-write", "openExternal", "pointerLock", "idle-detection", "window-management", "display-capture", "unknown", "future-permission"]) {
          const answer = vi.fn();
          request(null as never, permission as never, answer, {} as never);
          expect(answer, permission).toHaveBeenCalledExactlyOnceWith(false);
          expect(check(null, permission as never, "https://identity.example.test", {} as never), permission).toBe(false);
        }
        const device = vi.mocked(ses.setDevicePermissionHandler).mock.calls[0][0]!;
        for (const deviceType of ["hid", "serial", "usb"]) expect(device({ deviceType } as never)).toBe(false);
        expect(ses.clearStorageData).not.toHaveBeenCalled();
      } finally { await attempt.finish(); }
    });

    it.each(["main", "popup"])("refuses external protocols in every frame of the %s guest", async target => {
      const attempt = start();
      try {
        const guest = new FakeWebContents();
        constructed[0].webContents.emit("did-attach-webview", {}, guest);
        const page = target === "popup" ? popupContents(openPopup(guest)) : guest;
        for (const url of ["mailto:someone@example.test", "custom:launch", "file:///private", "javascript:alert(1)"]) {
          const preventDefault = vi.fn();
          page.emit("will-frame-navigate", { url, isMainFrame: false, preventDefault });
          expect(preventDefault, url).toHaveBeenCalledOnce();
        }
        const preventDefault = vi.fn();
        page.emit("will-frame-navigate", { url: "https://identity.example.test/frame", isMainFrame: false, preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
      } finally { await attempt.finish(); }
    });

    it("shows address and TLS chrome, hardens the guest and supports popup navigation and certificate errors", async () => {
      const attempt = start();
      try {
        const win = constructed[0];
        const html = decodeURIComponent(win.loadURL.mock.calls[0][0]);
        expect(html).toContain('id="oauth-domain" dir="ltr"');
        expect(html).toContain('id="oauth-security"');
        expect(html).not.toContain("ave-oauth-system-browser:");
        const preferences = { preload: "unsafe.js", preloadURL: "file:///unsafe.js" };
        win.webContents.emit("will-attach-webview", { preventDefault: vi.fn() }, preferences, { src: "https://auth.example.test/authorize" });
        expect(preferences).toMatchObject({ sandbox: true, nodeIntegration: false, webviewTag: false });
        expect(preferences).not.toHaveProperty("preload");
        const guest = new FakeWebContents();
        win.webContents.emit("did-attach-webview", {}, guest);
        const endpoint = "https://accounts.google.com/o/oauth2/v2/auth";
        const preventDefault = vi.fn();
        guest.emit("will-redirect", { url: endpoint, preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
        const popup = openPopup(guest, endpoint);
        const page = popupContents(popup);
        popup.loadURL.mockRejectedValueOnce(Object.assign(new Error("Navigation superseded"), { code: "ERR_ABORTED" }));
        page.emit("did-navigate", {}, "http://identity.example.test/next");
        expect(decodeURIComponent(popup.loadURL.mock.calls.at(-1)![0])).toContain("http://identity.example.test/next");
        page.emit("did-navigate", {}, "https://invalid.example.test");
        page.emit("did-fail-load", { errorCode: -202, validatedURL: "https://invalid.example.test", isMainFrame: true }, -202, "ERR_CERT_AUTHORITY_INVALID", "https://invalid.example.test", true);
        expect(shellState(popup).security.dataset.security).toBe("certificate-error");
        expect(page.executeJavaScript).not.toHaveBeenCalled();
        expect(page.preferences).not.toHaveProperty("preload");
        await flush(1);
        expect(popup.isDestroyed()).toBe(false);
        guest.emit("did-fail-load", { errorCode: -202, validatedURL: "https://invalid.example.test", isMainFrame: true });
        expect(win.isDestroyed()).toBe(false);
      } finally { await attempt.finish(); }
    });
  });

  it.each(["plugin-auth:sampleportal", "persist:plugin-auth:sampleportal:vault"])("preserves cookie storage on close for %s", async partition => {
    const { session } = await import("electron");
    const ses = session.fromPartition(partition);
    for (const clear of [ses.clearStorageData, ses.clearCache, ses.clearAuthCache]) vi.mocked(clear).mockClear();
    const pending = openAuthWindow(parent(), { url: "https://auth.example.test", completionUrlPatterns: [COMPLETION], cookieHosts: [COOKIE_HOST], persistPartition: partition });
    const result = pending.catch(error => error);
    constructed[0].close();
    await result;
    expect(ses.clearStorageData).not.toHaveBeenCalled();
    expect(ses.clearCache).not.toHaveBeenCalled();
    expect(ses.clearAuthCache).not.toHaveBeenCalled();
  });

  it("gives every OAuth popup its own address and certificate indicator without injecting into the guest", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
    });
    try {
      const guest = new FakeWebContents();
      constructed[0].webContents.emit("did-attach-webview", {}, guest);
      const popup = openPopup(guest);
      const page = popupContents(popup);
      const location = "http://127.0.0.1:12345/callback?code=private";
      page.emit("did-navigate", {}, location);
      const html = decodeURIComponent(popup.loadURL.mock.calls.at(-1)![0]);
      expect(html).toContain('id="oauth-domain" dir="ltr"');
      expect(html).toContain(location);
      expect(html).not.toContain("<webview");
      page.emit("did-navigate", {}, "https://invalid.example.test/");
      page.emit("did-fail-load", {}, -202, "ERR_CERT_AUTHORITY_INVALID", "https://invalid.example.test/", true);
      expect(shellState(popup).security.dataset.security).toBe("certificate-error");
      expect(page.executeJavaScript).not.toHaveBeenCalled();
      expect(page.preferences).not.toHaveProperty("preload");
    } finally { complete(); await pending; }
  });

  it.each([
    ["oauth", "https://accounts.google.com/signin/oauth/error?authError=ZGlzYWxsb3dlZF91c2VyYWdlbnQ"],
    ["cookie", "https://accounts.google.com/signin/oauth/error?authError=ZGlzYWxsb3dlZF91c2VyYWdlbnQ"],
  ])("escalates %s navigation to %s without harvesting cookies", async (lane, authorization) => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let complete!: () => void;
    const url = "https://auth.example.test/authorize?state=original";
    const pending = lane === "oauth" ? openOAuthInAuthWindow(parent(), url, {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
    }) : openAuthWindow(parent(), { url, completionUrlPatterns: [COMPLETION], cookieHosts: [COOKIE_HOST] });
    const result = pending.catch(error => error);
    const win = constructed[0];
    const guest = new FakeWebContents();
    win.webContents.emit("did-attach-webview", {}, guest);
    const preventDefault = vi.fn();
    guest.emit("will-redirect", { url: authorization, preventDefault });
    await flush(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith(lane === "oauth" || authorization.includes("/error?") ? url : authorization);
    expect(win.isDestroyed()).toBe(true);
    expect(guest.session.cookies.get).not.toHaveBeenCalled();
    if (lane === "oauth") complete();
    const outcome = await result;
    if (lane === "cookie") expect(outcome).toBeInstanceOf(Error);
  });

  it.each(["complete", "cancel", "timeout"])("shares a hardened popup session and destroys popups before clearing storage on %s", async outcome => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const { session } = await import("electron");
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 1_000,
    });
    const result = pending.catch(error => error);
    const win = constructed[0];
    const guest = new FakeWebContents();
    win.webContents.emit("did-attach-webview", {}, guest);
    try {
      expect(decodeURIComponent(win.loadURL.mock.calls[0][0])).toContain("allowpopups");
      const popup = openPopup(guest);
      const prefs = popupContents(popup).preferences;
      expect(popup.options.parent).toBe(win);
      expect(prefs.session).toBe(session.fromPartition("unused"));
      expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
      expect(prefs).not.toHaveProperty("preload");
      expect(popup.options).not.toHaveProperty("noopener");
      if (outcome === "complete") complete();
      if (outcome === "cancel") win.close();
      await result;
      expect(popup.isDestroyed()).toBe(true);
      expect(popup.destroy.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(session.fromPartition("unused").clearStorageData).mock.invocationCallOrder.at(-1)!);
    } finally { complete(); win.close(); await result; }
  });

  it("denies non-http popup schemes, recursive navigation, foreign sessions and excessive nesting or count", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
    });
    try {
      const guest = new FakeWebContents();
      constructed[0].webContents.emit("did-attach-webview", {}, guest);
      const handler = guest.setWindowOpenHandler.mock.calls.at(-1)![0];
      for (const url of ["javascript:alert(1)", "file:///secret", "about:blank", "ave:privileged"]) expect(handler({ url }).action).toBe("deny");
      const first = openPopup(guest);
      const second = openPopup(popupContents(first));
      const third = openPopup(popupContents(second));
      expect(popupContents(third).setWindowOpenHandler.mock.calls.at(-1)![0]({ url: "https://identity.example.test" }).action).toBe("deny");
      const preventDefault = vi.fn();
      popupContents(third).emit("will-redirect", { url: "file:///secret", preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      openPopup(guest);
      const fifth = openPopup(guest);
      expect(handler({ url: "https://identity.example.test" }).action).toBe("deny");
      fifth.close();
      openPopup(guest);
      const foreign = new FakeBrowserWindow();
      guest.emit("did-create-window", foreign, { url: "https://identity.example.test" });
      expect(foreign.destroy).toHaveBeenCalledOnce();
    } finally { complete(); await pending; }
  });

  it("keeps the opener message and script-close sequence usable with a real callback", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const catchers = new AuthRedirectCatchers();
    const catcher = await catchers.open("popup-login", { state: "popup-state", redirectHost: "127.0.0.1" });
    const completion = catchers.wait("popup-login", catcher.handle, 10_000);
    const onCancel = vi.fn();
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", { completion, onCancel, timeoutMs: 10_000 });
    try {
      const guest = new FakeWebContents();
      constructed[0].webContents.emit("did-attach-webview", {}, guest);
      const popup = openPopup(guest);
      let callback!: Promise<Response>;
      const postMessage = vi.fn(() => {
        const url = `${catcher.redirectUri}/?code=popup-code&state=popup-state`;
        const preventDefault = vi.fn();
        popupContents(popup).emit("will-redirect", { url, preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
        callback = fetch(url);
      });
      runInNewContext('window.opener.postMessage("signed-in", "https://auth.example.test"); window.close();', {
        window: { opener: { postMessage }, close: () => popupContents(popup).close() },
      });
      expect(postMessage).toHaveBeenCalledWith("signed-in", "https://auth.example.test");
      expect(popup.isDestroyed()).toBe(true);
      await callback;
      await pending;
      expect(onCancel).not.toHaveBeenCalled();
    } finally { catchers.close("popup-login", catcher.handle); await pending.catch(() => undefined); }
  });

  it("harvests plugin cookies when completion lands in a popup", async () => {
    const { session } = await import("electron");
    const cookie = { name: "session", value: "private", domain: COOKIE_HOST } as Cookie;
    vi.mocked(session.fromPartition("unused").cookies.get).mockResolvedValueOnce([cookie]);
    const pending = openAuthWindow(parent(), { url: "https://auth.example.test", completionUrlPatterns: [COMPLETION], cookieHosts: [COOKIE_HOST], persistPartition: PARTITION });
    try {
      const guest = new FakeWebContents();
      constructed[0].webContents.emit("did-attach-webview", {}, guest);
      const popup = openPopup(guest);
      vi.spyOn(popupContents(popup), "getURL").mockReturnValue(`https://${COMPLETION}`);
      popupContents(popup).emit("did-navigate", {}, `https://${COMPLETION}`);
      await expect(pending).resolves.toEqual([expect.objectContaining({ name: "session", value: "private" })]);
      expect(popup.isDestroyed()).toBe(true);
    } finally { constructed[0].close(); await pending.catch(() => undefined); }
  });

  it.each([false, true])("routes authorization using endpoint data with system=%s and completes through its real catcher", async system => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const { shell } = await import("electron");
    const catchers = new AuthRedirectCatchers();
    const catcher = await catchers.open("direct-browser", { state: "browser-state", redirectHost: "127.0.0.1" });
    const completion = catchers.wait("direct-browser", catcher.handle, 10_000);
    const url = system ? "https://client.example.test/authorize?state=browser-state&code_challenge=unchanged"
      : "https://accounts.google.com/o/oauth2/v2/auth?state=browser-state&code_challenge=unchanged";
    if (system) SYSTEM_BROWSER_OAUTH_ENDPOINTS.push({ hostname: "client.example.test", pathPrefix: "/authorize" });
    const onCancel = vi.fn();
    const pending = openOAuthInAuthWindow(parent(), url, { completion, onCancel, timeoutMs: 10_000 });
    try {
      await flush(1);
      if (system) {
        expect(constructed).toHaveLength(0);
        expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      } else {
        expect(constructed).toHaveLength(1);
        const guest = new FakeWebContents();
        constructed[0].webContents.emit("did-attach-webview", {}, guest);
        const preventDefault = vi.fn();
        guest.emit("will-redirect", { url, preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
      }
      await fetch(`${catcher.redirectUri}/?code=browser-code&state=browser-state`, { redirect: "manual" });
      await pending;
      await expect(completion).resolves.toMatchObject({ code: "browser-code", state: "browser-state" });
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      if (system) SYSTEM_BROWSER_OAUTH_ENDPOINTS.pop();
      catchers.close("direct-browser", catcher.handle);
      await pending.catch(() => undefined);
    }
  });

  it.each(["https://accounts.google.com.attacker.test/auth", "https://accounts.google.com@auth.example.test/auth"])(
    "keeps lookalike authorization host %s in the isolated window", async (url) => {
      const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
      let complete!: () => void;
      const pending = openOAuthInAuthWindow(parent(), url, {
        completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
      });
      expect(constructed).toHaveLength(1);
      complete();
      await pending;
    },
  );

  it("gives neither the OAuth shell nor its guest a preload or internal IPC bridge", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
    });
    try {
      const win = constructed[0];
      expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
      expect(win.options.webPreferences).not.toHaveProperty("preload");
      const prefs = { preload: "untrusted.js", preloadURL: "file:///untrusted.js" };
      win.webContents.emit("will-attach-webview", { preventDefault: vi.fn() }, prefs, { src: "https://auth.example.test/authorize" });
      expect(prefs).not.toHaveProperty("preload");
      expect(prefs).not.toHaveProperty("preloadURL");
      expect(prefs).toMatchObject({ sandbox: true, nodeIntegration: false, webviewTag: false });
      const html = decodeURIComponent(win.loadURL.mock.calls[0][0]);
      expect(html).not.toMatch(/aveWindow|ipcRenderer|localStorage|sessionStorage/);
    } finally { complete(); await pending; }
  });

  it.each(["complete", "cancel", "timeout"])("clears ephemeral storage and cache after %s", async outcome => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const { session } = await import("electron");
    const partitionSession = session.fromPartition("unused");
    vi.mocked(partitionSession.clearStorageData).mockClear();
    vi.mocked(partitionSession.clearCache).mockClear();
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 1_000,
    });
    const result = pending.catch(() => undefined);
    if (outcome === "complete") complete();
    if (outcome === "cancel") constructed[0].close();
    await result;
    expect(session.fromPartition).toHaveBeenLastCalledWith(expect.stringMatching(/^ephemeral-auth-/));
    expect(partitionSession.clearStorageData).toHaveBeenCalledOnce();
    expect(partitionSession.clearCache).toHaveBeenCalledOnce();
  });

  it("redacts authorization secrets and tokens from navigation and failure logs", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const logger = authWindowLogger();
    for (const method of Object.values(logger)) if (vi.isMockFunction(method)) method.mockClear();
    const secrets = ["sensitive-code", "sensitive-state", "sensitive-token"];
    const url = `https://auth.example.test/authorize?code=${secrets[0]}&state=${secrets[1]}#access_token=${secrets[2]}`;
    const pending = openOAuthInAuthWindow(parent(), url, {
      completion: new Promise<void>(() => {}), onCancel: vi.fn(), timeoutMs: 10_000,
    });
    const result = pending.catch(() => undefined);
    const win = constructed[0];
    const guest = new FakeWebContents();
    win.webContents.emit("did-attach-webview", {}, guest);
    guest.emit("did-navigate", {}, url);
    guest.emit("did-fail-load", { isMainFrame: true, errorCode: -2, errorDescription: url, validatedURL: url });
    await result;
    const output = JSON.stringify(Object.values(logger).filter(vi.isMockFunction).map(method => method.mock.calls));
    expect(output).toContain("auth-window:open");
    for (const secret of secrets) expect(output).not.toContain(secret);
  });

  it("uses a fresh memory partition and closes only after callback completion without harvesting cookies", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const onCancel = vi.fn();
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize?state=secret", {
      completion, onCancel, timeoutMs: 10_000,
    });
    const win = constructed[0];
    const html = decodeURIComponent(win.loadURL.mock.calls[0][0].split(",").slice(1).join(","));
    expect(html).toMatch(/ephemeral-auth-[a-f0-9]+/);
    expect(html).not.toMatch(/partition = "persist:/);
    expect(html).not.toContain("ave-oauth-system-browser:");
    const contents = new FakeWebContents();
    win.webContents.emit("did-attach-webview", {}, contents);
    await flush(1);
    expect(win.close).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(win.close).toHaveBeenCalledOnce();
    expect(contents.session.cookies.get).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels the catcher when the user closes the window", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const onCancel = vi.fn();
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(() => {}), onCancel, timeoutMs: 10_000,
    });
    const outcome = expect(pending).rejects.toThrow(/closed before login completed/);
    constructed[0].close();
    await outcome;
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("hands off a refusal once, closes the window and still accepts its real callback", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const { shell } = await import("electron");
    const catchers = new AuthRedirectCatchers();
    const catcher = await catchers.open("oauth-window-test", { state: "original", redirectHost: "127.0.0.1" });
    const completion = catchers.wait("oauth-window-test", catcher.handle, 10_000);
    const url = "https://auth.example.test/authorize?state=original&code_challenge=pkce";
    const onCancel = vi.fn(() => catchers.close("oauth-window-test", catcher.handle));
    const pending = openOAuthInAuthWindow(parent(), url, {
      completion, onCancel, timeoutMs: 10_000,
    });
    const win = constructed[0];
    const guest = new FakeWebContents();
    win.webContents.emit("did-attach-webview", {}, guest);
    const logger = authWindowLogger();
    logger.info.mockClear();
    const refusal = `https://accounts.google.com/signin/oauth/error?authError=${Buffer.from("\u000a\u0014disallowed_useragent").toString("base64url")}&state=private-state`;
    guest.emit("did-navigate", {}, refusal);
    guest.emit("did-navigate-in-page", {}, refusal);
    await flush(1);
    expect(shell.openExternal).toHaveBeenCalledWith(url);
    expect(guest.executeJavaScript).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.filter((args: unknown[]) => String(args[0]).includes("[auth-window:system-browser]"))).toEqual([["[auth-window:system-browser] accounts.google.com"]]);
    expect(win.isDestroyed()).toBe(true);
    await fetch(`${catcher.redirectUri}/?code=received&state=original`, { redirect: "manual" });
    await pending;
    await expect(completion).resolves.toMatchObject({ code: "received", state: "original" });
    catchers.close("oauth-window-test", catcher.handle);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("blocks privileged schemes from the shell and guest", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const { shell } = await import("electron");
    vi.mocked(shell.openExternal).mockClear();
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>((resolve) => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
    });
    const contents = new FakeWebContents();
    constructed[0].webContents.emit("did-attach-webview", {}, contents);
    const preventDefault = vi.fn();
    contents.emit("will-navigate", { url: "ave-oauth-system-browser:", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(shell.openExternal).not.toHaveBeenCalled();
    complete();
    await pending;
  });

  it.each([
    "https://other.example.test/signin/oauth/error?authError=ZGlzYWxsb3dlZF91c2VyYWdlbnQ",
    "https://accounts.google.com/other?authError=ZGlzYWxsb3dlZF91c2VyYWdlbnQ",
  ])("ignores unrelated or unencoded refusal signals: %s", async url => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    let complete!: () => void;
    const pending = openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(resolve => { complete = resolve; }), onCancel: vi.fn(), timeoutMs: 10_000,
    });
    try {
      const guest = new FakeWebContents();
      constructed[0].webContents.emit("did-attach-webview", {}, guest);
      guest.emit("did-navigate", {}, url);
      expect(constructed[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    } finally { complete(); await pending; }
  });

  it("bounds the attempt and releases its catcher on timeout", async () => {
    const { openOAuthInAuthWindow } = await import("../auth-window-service.js");
    const onCancel = vi.fn();
    await expect(openOAuthInAuthWindow(parent(), "https://auth.example.test/authorize", {
      completion: new Promise<void>(() => {}), onCancel, timeoutMs: 1_000,
    })).rejects.toThrow(/login timeout/);
    expect(constructed[0].close).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("openAuthWindow — visible-window dedup", () => {
  it("opening twice for the same partition+title creates ONE window and focuses the existing one", async () => {
    const p = parent();
    const opts = {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION],
      cookieHosts: [COOKIE_HOST],
      windowTitle: "Internal Portal Login",
      persistPartition: PARTITION,
      timeoutMs: 10_000,
    };

    const first = openAuthWindow(p, opts);
    const firstOutcome = first.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);
    const { session } = await import("electron");
    const partitionSession = vi.mocked(session.fromPartition).mock.results[0]?.value as { setUserAgent: ReturnType<typeof vi.fn> };
    expect(session.fromPartition).toHaveBeenCalledWith(PARTITION);
    expect(partitionSession.setUserAgent).toHaveBeenCalledWith(buildPersistentBrowserUserAgent());
    expect(partitionSession.setUserAgent.mock.calls[0]?.[0]).toMatch(/Safari\/537\.36 Ave\/0\.14\.1$/);
    // The parent window itself was constructed; the FIRST auth window is the most recent construction after that.
    const authWindowsAfterFirst = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow));
    expect(authWindowsAfterFirst).toHaveLength(1);
    const firstWindow = authWindowsAfterFirst[0];

    // Second concurrent call for the SAME key — must NOT spawn a new window.
    const second = openAuthWindow(p, opts);
    const secondOutcome = second.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);

    const authWindowsAfterSecond = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow));
    expect(authWindowsAfterSecond).toHaveLength(1); // still only ONE auth window
    expect(firstWindow.focus).toHaveBeenCalledTimes(1); // existing window focused

    // Both calls share the same in-flight promise; settle by closing the window.
    firstWindow.close();
    await flush(2);
    const r1 = await firstOutcome;
    const r2 = await secondOutcome;
    expect(r1.ok).toBe(false); // closed-before-completion reject (shared outcome)
    expect(r2.ok).toBe(false);
  });

  it("a show:false silent warmup is exempt — it does NOT reuse the visible window", async () => {
    const p = parent();
    const visible = openAuthWindow(p, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION],
      cookieHosts: [COOKIE_HOST],
      windowTitle: "Internal Portal Login",
      persistPartition: PARTITION,
      timeoutMs: 10_000,
    });
    const visibleOutcome = visible.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);
    const beforeWarmup = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow)).length;
    expect(beforeWarmup).toBe(1);

    // Silent warmup (show:false) for the SAME key — must construct its OWN window.
    const warmup = openAuthWindow(p, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION],
      cookieHosts: [COOKIE_HOST],
      windowTitle: "Internal Portal Login",
      persistPartition: PARTITION,
      show: false,
      timeoutMs: 5_000,
    });
    const warmupOutcome = warmup.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);

    const afterWarmup = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow)).length;
    expect(afterWarmup).toBe(2); // warmup got its own window, not the visible one

    // Settle both — close every constructed auth window.
    for (const w of constructed) w.close();
    await flush(2);
    await visibleOutcome;
    await warmupOutcome;
  });
});
