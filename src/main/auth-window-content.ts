import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BrowserWindow, WebContentsView, nativeTheme, type Session, type WebContents } from "electron";
import { buildTitlebarCss, TITLEBAR_COLORS } from "./window-titlebar-shell.js";
import { hardenRemoteWebPreferences } from "./remote-browser-preferences.js";
import { markAsAuthOwned } from "./auth-window-registry.js";
import { escapeHtml } from "../shared/escape-html.js";
import { t } from "../i18n/index.js";

const requireFromHere = createRequire(import.meta.url);

// Development console source — read once on demand and cached. Lets the auth shell + the embedded webview both inline a working in-page console without the
// webview having to fetch any external script (its CSP comes from the remote server and would block <script src=...>).
let cachedErudaSource: string | null = null;
function getErudaSource(): string | null {
  if (cachedErudaSource !== null) return cachedErudaSource;
  try {
    const erudaPath = requireFromHere.resolve("eruda");
    cachedErudaSource = readFileSync(erudaPath, "utf8");
    return cachedErudaSource;
  } catch {
    return null;
  }
}

const AUTH_TITLEBAR_HEIGHT = 36;

type AuthWindowChromeOptions = Pick<Electron.BrowserWindowConstructorOptions,
  "frame" | "minWidth" | "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay">;

/** Native controls share the trusted address row; neither shell needs a privileged preload. */
export function authWindowChromeOptions(platform: NodeJS.Platform = process.platform, dark = nativeTheme.shouldUseDarkColors): AuthWindowChromeOptions {
  const colors = TITLEBAR_COLORS[dark ? "dark" : "light"];
  return {
    frame: true,
    minWidth: 520,
    titleBarStyle: platform === "darwin" ? "hiddenInset" : "hidden",
    ...(platform === "darwin" ? { trafficLightPosition: { x: 12, y: 11 } } : { titleBarOverlay: { height: AUTH_TITLEBAR_HEIGHT, color: colors.background, symbolColor: colors.foreground } }),
  };
}

/** Keep native overlay controls in step with the shell's system-theme media query. */
export function wireAuthWindowTheme(window: BrowserWindow, platform: NodeJS.Platform = process.platform): void {
  if (platform === "darwin") return;
  const update = (): void => {
    const colors = TITLEBAR_COLORS[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
    window.setTitleBarOverlay({ height: AUTH_TITLEBAR_HEIGHT, color: colors.background, symbolColor: colors.foreground });
  };
  update();
  nativeTheme.on("updated", update);
  window.once("closed", () => nativeTheme.off("updated", update));
}

// The installed parser includes the maintained public suffix list, including private suffixes.
let cachedDomainParserSource: string | undefined;
function getDomainParserSource(): string {
  return cachedDomainParserSource ??= readFileSync(new URL(import.meta.resolve("tldts/dist/index.umd.min.js")), "utf8");
}

type AuthDocumentError = "" | "certificate-error" | "load-error";

export function buildAuthWindowShellHtml(input: {
  title: string;
  url: string;
  partition: string;
  // Reserve native control space within the same host-rendered address row.
  platform?: NodeJS.Platform;
  // When true, inline the development console script.
  devConsole?: boolean;
  chromeOnly?: boolean;
  errorState?: AuthDocumentError;
}): string {
  const platform: NodeJS.Platform = input.platform ?? process.platform;
  const title = JSON.stringify(input.title).replace(/</g, "\\u003c");
  const url = JSON.stringify(input.url).replace(/</g, "\\u003c");
  const partition = JSON.stringify(input.partition).replace(/</g, "\\u003c");
  const erudaScript = input.devConsole === true ? buildErudaInlineScript() : "";
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src http: https:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>${buildTitlebarCss()}
    #oauth-location { display: flex; flex: 0 0 ${AUTH_TITLEBAR_HEIGHT}px; height: ${AUTH_TITLEBAR_HEIGHT}px; align-items: center; gap: 8px; padding: 0 ${platform === "darwin" ? "12px 0 80px" : "140px 0 12px"}; background: var(--ts-bg); color: var(--ts-fg); -webkit-app-region: drag; }
    #oauth-security { flex: 0 0 16px; height: 16px; -webkit-app-region: no-drag; }
    #oauth-security svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    #oauth-security[data-security="certificate-error"], #oauth-security[data-security="load-error"] { color: #d33c32; }
    #oauth-uri { display: flex; align-items: baseline; min-width: 0; overflow: hidden; white-space: nowrap; font-size: 12px; direction: ltr; -webkit-app-region: no-drag; user-select: text; }
    #oauth-host { display: flex; flex: 0 1 auto; min-width: 0; }
    #oauth-subdomain { min-width: 0; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; color: var(--ts-btn); }
    #oauth-domain { flex: 0 0 auto; font-weight: 650; }
    #oauth-port { flex: 0 0 auto; }
    #oauth-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    #oauth-security[data-security="http"] { color: #9a6700; }
    @media (prefers-color-scheme: dark) { #oauth-security[data-security="http"] { color: #f0b64c; } }
    #oauth-scheme, #oauth-path { color: var(--ts-btn); }
    #oauth-scheme { flex: 0 0 auto; }
    #oauth-path { flex: 0 1000 auto; min-width: 1em; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body>
  <div id="oauth-location"><span id="oauth-security" role="img"></span><div id="oauth-uri" role="group" tabindex="0" aria-label="${escapeHtml(t("oauthWindow.address"))}"><span id="oauth-scheme"></span><span id="oauth-host"><span id="oauth-subdomain"><bdi id="oauth-subdomain-text" dir="ltr"></bdi></span><bdi id="oauth-domain" dir="ltr"></bdi><span id="oauth-port"></span></span><span id="oauth-path"></span></div><span id="oauth-status" role="status" aria-live="polite" aria-atomic="true"></span></div>
  ${input.chromeOnly ? "" : '<webview id="auth-view" src="" partition="" allowpopups></webview>'}
  <script>
    ${getDomainParserSource()}
    const title = ${title};
    const url = ${url};
    const partition = ${partition};
    document.title = title;
    const titleEl = document.getElementById("title");
    if (titleEl) titleEl.textContent = title;
    const view = document.getElementById("auth-view");
    const uri = document.getElementById("oauth-uri");
    const security = document.getElementById("oauth-security");
    let committedUrl = url;
    let errorState = ${JSON.stringify(input.errorState ?? "")};
    const certificateErrors = new Set();
    uri.addEventListener("copy", event => {
      event.clipboardData.setData("text/plain", committedUrl);
      event.preventDefault();
    });
    const updateLocation = () => {
      if (!uri || !security) return;
      uri.title = committedUrl;
      const scheme = document.getElementById("oauth-scheme");
      const subdomain = document.getElementById("oauth-subdomain-text");
      const domain = document.getElementById("oauth-domain");
      const port = document.getElementById("oauth-port");
      const path = document.getElementById("oauth-path");
      if (/^https?:/i.test(committedUrl)) {
        const parsed = new URL(committedUrl);
        const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
        const registrableDomain = tldts.getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
        scheme.textContent = parsed.protocol + "//";
        subdomain.textContent = hostname.slice(0, hostname.length - registrableDomain.length);
        domain.textContent = registrableDomain + (hostname === parsed.hostname ? "" : ".");
        port.textContent = parsed.port ? ":" + parsed.port : "";
        path.textContent = parsed.pathname + parsed.search + parsed.hash;
      } else {
        scheme.textContent = subdomain.textContent = domain.textContent = port.textContent = "";
        path.textContent = committedUrl;
      }
      const secure = committedUrl.startsWith("https:") && !errorState;
      const label = errorState === "certificate-error" ? ${JSON.stringify(t("oauthWindow.certificateError"))} : errorState === "load-error" ? ${JSON.stringify(t("oauthWindow.loadError"))} : secure ? ${JSON.stringify(t("oauthWindow.secure"))} : ${JSON.stringify(t("oauthWindow.insecure"))};
      const status = document.getElementById("oauth-status");
      if (status.textContent !== label) status.textContent = label;
      security.title = label;
      security.setAttribute("aria-label", label);
      security.dataset.security = errorState || (secure ? "https" : "http");
      const shape = errorState === "certificate-error" ? '<path d="m8 8 8 8m0-8-8 8"/><circle cx="12" cy="12" r="9"/>' : errorState === "load-error" ? '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/>' : secure ? '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>' : '<path d="m12 2 10 10-10 10L2 12Z"/><path d="M12 7v6m0 4h.01"/>';
      security.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + shape + '</svg>';
    };
    const recordFailure = (failedUrl, certificateFailure) => {
      committedUrl = failedUrl;
      errorState = certificateFailure ? "certificate-error" : "load-error";
      if (certificateFailure) certificateErrors.add(failedUrl.split("#", 1)[0]);
      updateLocation();
    };
    const commitLocation = (currentUrl, sameDocument) => {
      committedUrl = currentUrl;
      if (!sameDocument) errorState = certificateErrors.has(currentUrl.split("#", 1)[0]) ? "certificate-error" : "";
      updateLocation();
    };
    updateLocation();
    if (view) {
      view.addEventListener("did-start-navigation", e => {
        if (e.isMainFrame !== false && !e.isInPlace) certificateErrors.clear();
      });
      view.addEventListener("did-navigate", e => { if (e.isMainFrame !== false) commitLocation(e.url, false); });
      view.addEventListener("did-navigate-in-page", e => { if (e.isMainFrame !== false) commitLocation(e.url, true); });
      view.addEventListener("did-fail-load", e => {
        // A non-aborted main-frame failure commits an error document without did-navigate.
        if (e.isMainFrame && e.errorCode !== -3) recordFailure(e.validatedURL, e.errorCode <= -200 && e.errorCode >= -299);
      });
      view.setAttribute("partition", partition);
      view.setAttribute("src", url);
    }
  </script>
  ${erudaScript}
</body>
</html>`;
}

function buildErudaInlineScript(): string {
  const src = getErudaSource();
  if (!src) return "";
  // A failed development console must not prevent login; the page guard avoids duplicate initialization.
  return `<script>${src}
;try{if(!window.__ave_eruda_booted){window.__ave_eruda_booted=true;eruda.init();}}catch(e){console.error("[ave] auth shell development console failed", e);}</script>`;
}


export interface AuthNavigationFailure {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

/** Login documents need no privileged web API grants; native credential prompts do not require WebUSB or WebHID access. */
export function installAuthSessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}

/** The local chrome and all remote guests share one security and popup boundary. */
export function attachAuthWindowContent(input: {
  window: BrowserWindow;
  session: Session;
  partition: string;
  title: string;
  url: string;
  devConsole: boolean;
  active(): boolean;
  onRefusal(url: string): boolean;
  onNavigation(url: string, committed: boolean): void;
  onCheck(contents: WebContents): void;
  onAttached(contents: WebContents): void;
  onFailure(event: AuthNavigationFailure): void;
}): { close(): Promise<void> } {
  const { window, session, partition, title } = input;
  const popups = new Set<BrowserWindow>();
  const teardowns: Promise<void>[] = [];
  let pendingPopups = 0;
  const isHttpUrl = (value: string): boolean => {
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
  };
  // Sign-in pages build helper iframes from about:blank/srcdoc; neither can launch an external protocol.
  const isSubframeUrl = (value: string): boolean => isHttpUrl(value) || value === "about:blank" || value === "about:srcdoc";
  const guardShell = (shell: BrowserWindow): void => {
    shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    shell.webContents.on("will-navigate", event => event.preventDefault());
    shell.webContents.on("will-frame-navigate", event => event.preventDefault());
    shell.webContents.on("will-redirect", event => event.preventDefault());
  };
  wireAuthWindowTheme(window);
  guardShell(window);
  const closePopups = (): void => {
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    popups.clear();
  };
  window.on("closed", closePopups);
  const updateLocation = (popup: BrowserWindow, url: string, errorState: AuthDocumentError = ""): void => {
    if (popup.isDestroyed()) return;
    const html = buildAuthWindowShellHtml({ title, url, partition, chromeOnly: true, errorState });
    void popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_ABORTED") return;
      if (!popup.isDestroyed()) popup.destroy();
    });
  };
  const attachGuest = (contents: WebContents, depth = 0, popup?: BrowserWindow): void => {
    let committedUrl = "";
    let errorState: AuthDocumentError = "";
    const certificateErrors = new Set<string>();
    const recordFailure = (url: string, certificateFailure: boolean): void => {
      if (!input.active()) return;
      committedUrl = url;
      errorState = certificateFailure ? "certificate-error" : "load-error";
      if (certificateFailure) certificateErrors.add(url.split("#", 1)[0]);
      if (popup) {
        updateLocation(popup, committedUrl, errorState);
      } else if (!window.isDestroyed()) {
        // Only the trusted local chrome receives this status; remote documents are never scripted.
        void window.webContents.executeJavaScript(`recordFailure(${JSON.stringify(url)}, ${certificateFailure})`).catch(() => undefined);
      }
    };
    const commitLocation = (url: string, sameDocument: boolean): void => {
      if (!input.active()) return;
      committedUrl = url;
      if (!sameDocument) errorState = certificateErrors.has(url.split("#", 1)[0]) ? "certificate-error" : "";
      if (popup) updateLocation(popup, committedUrl, errorState);
    };
    markAsAuthOwned(contents);
    contents.setWindowOpenHandler(({ url }) => {
      if (!input.active() || window.isDestroyed() || !isHttpUrl(url) || depth >= 3 || popups.size + pendingPopups >= 5) return { action: "deny" };
      if (input.onRefusal(url)) return { action: "deny" };
      pendingPopups++;
      const preferences: Record<string, unknown> = { session };
      hardenRemoteWebPreferences(preferences);
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: window, width: 520, height: 720, autoHideMenuBar: true, ...authWindowChromeOptions(),
          webPreferences: preferences,
        },
        createWindow: (options: Electron.BrowserWindowConstructorOptions) => {
          pendingPopups--;
          // Adopt the supplied guest to preserve its native opener and message channel.
          const { webContents, x, y, width, height } = options as Electron.BrowserWindowConstructorOptions & { webContents: WebContents };
          if (!input.active() || window.isDestroyed() || webContents.session !== session) {
            webContents.close({ waitForBeforeUnload: false });
            throw new Error("Invalid auth popup session");
          }
          const child = new BrowserWindow({
            parent: window, x, y, width, height, autoHideMenuBar: true, ...authWindowChromeOptions(),
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
          });
          wireAuthWindowTheme(child);
          guardShell(child);
          const guest = new WebContentsView({ webContents });
          child.contentView.addChildView(guest);
          teardowns.push(new Promise<void>(resolve => webContents.once("destroyed", () => resolve())));
          const resize = (): void => {
            const { width, height } = child.getContentBounds();
            guest.setBounds({ x: 0, y: AUTH_TITLEBAR_HEIGHT, width, height: Math.max(0, height - AUTH_TITLEBAR_HEIGHT) });
          };
          resize();
          child.on("resize", resize);
          popups.add(child);
          child.on("closed", () => {
            popups.delete(child);
            if (!webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
          });
          webContents.on("destroyed", () => { if (!child.isDestroyed()) child.destroy(); });
          attachGuest(webContents, depth + 1, child);
          updateLocation(child, url);
          return webContents;
        },
      };
    });
    contents.on("did-create-window", child => {
      // Only the adopted, guarded guest path is admitted.
      if (!popups.has(child)) child.destroy();
    });
    const guardNavigation = (event: Electron.Event & { url: string; isMainFrame?: boolean }): void => {
      const mainFrame = event.isMainFrame !== false;
      if (!(mainFrame ? isHttpUrl(event.url) : isSubframeUrl(event.url)) || (mainFrame && input.onRefusal(event.url))) event.preventDefault();
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-frame-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    const track = (url: string, committed: boolean): void => {
      if (!input.active() || input.onRefusal(url)) return;
      input.onNavigation(url, committed);
    };
    contents.on("did-navigate", (event, url) => {
      if ((event as Electron.Event & { isMainFrame?: boolean }).isMainFrame === false) return;
      track(url, true);
      commitLocation(url, false);
      input.onCheck(contents);
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame === false) return;
      track(url, false);
      commitLocation(url, true);
      input.onCheck(contents);
    });
    contents.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame !== false) {
        if (!_isInPlace) certificateErrors.clear();
        track(url, false);
      }
    });
    contents.on("did-redirect-navigation", (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame !== false) track(url, false);
    });
    contents.on("certificate-error", (event, url, _error, _certificate, callback, isMainFrame) => {
      event.preventDefault();
      callback(false);
      if (isMainFrame) recordFailure(url, true);
    });
    const onFailure = (documentReplaced: boolean) => (event: Electron.Event, code: number, description: string, url: string, isMainFrame: boolean): void => {
      const details = event as unknown as Partial<AuthNavigationFailure>;
      const failure: AuthNavigationFailure = {
        errorCode: details.errorCode ?? code, errorDescription: details.errorDescription ?? description,
        validatedURL: details.validatedURL ?? url, isMainFrame: details.isMainFrame ?? isMainFrame,
      };
      if (!failure.isMainFrame) return;
      const certificateFailure = failure.errorCode <= -200 && failure.errorCode >= -299;
      if (documentReplaced && failure.errorCode !== -3) recordFailure(failure.validatedURL, certificateFailure);
      if (certificateFailure) return;
      input.onFailure(failure);
    };
    contents.on("did-fail-load", onFailure(true));
    contents.on("did-fail-provisional-load", onFailure(false));
    if (input.devConsole) {
      contents.on("did-finish-load", () => {
        const src = getErudaSource();
        if (src && !contents.isDestroyed()) void contents.executeJavaScript(`${src}\n;try{if(!window.__ave_eruda_booted){window.__ave_eruda_booted=true;eruda.init();}}catch{}`).catch(() => undefined);
      });
    }
    input.onCheck(contents);
  };
  window.webContents.on("did-attach-webview", (_event, contents) => {
    input.onAttached(contents);
    attachGuest(contents);
  });
  return { close: async () => { closePopups(); await Promise.all(teardowns); } };
}
