import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BrowserWindow, WebContentsView, type Session, type WebContents } from "electron";
import { buildTitlebarCss, buildTitlebarHtml, buildTitlebarButtonScript } from "./window-titlebar-shell.js";
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

type AuthDocumentError = "" | "certificate-error" | "load-error";

export function buildAuthWindowShellHtml(input: {
  title: string;
  url: string;
  partition: string;
  // macOS keeps native inset controls; Windows/Linux need HTML controls because the native frame is removed.
  platform?: NodeJS.Platform;
  // When true, inline the development console script.
  devConsole?: boolean;
  nativeFrame?: boolean;
  chromeOnly?: boolean;
  errorState?: AuthDocumentError;
}): string {
  const platform: NodeJS.Platform = input.platform ?? process.platform;
  const title = JSON.stringify(input.title);
  const url = JSON.stringify(input.url).replace(/</g, "\\u003c");
  const partition = JSON.stringify(input.partition);
  const erudaScript = input.devConsole === true ? buildErudaInlineScript() : "";
  const titleBarHtml = input.nativeFrame ? "" : buildTitlebarHtml({ platform, title: input.title });
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src http: https:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>${buildTitlebarCss()}
    #oauth-location { display: flex; flex: 0 0 64px; align-items: center; gap: 8px; padding: 0 12px; box-sizing: border-box; background: var(--ts-webview-bg); color: var(--ts-fg); }
    #oauth-uri { flex: 1; min-width: 0; padding: 6px; color: inherit; background: transparent; }
  </style>
</head>
<body>
  ${titleBarHtml}
  ${input.nativeFrame ? `<div id="oauth-location"><span id="oauth-security" role="status"></span><input id="oauth-uri" readonly aria-label="${escapeHtml(t("oauthWindow.address"))}" /></div>` : ""}
  ${input.chromeOnly ? "" : '<webview id="auth-view" src="" partition="" allowpopups></webview>'}
  <script>
    const title = ${title};
    const url = ${url};
    const partition = ${partition};
    document.title = title;
    const titleEl = document.getElementById("title");
    if (titleEl) titleEl.textContent = title;
    const view = document.getElementById("auth-view");
    const uri = document.getElementById("oauth-uri");
    const security = document.getElementById("oauth-security");
    let committedUrl = ${input.chromeOnly ? "url" : '""'};
    let errorState = ${JSON.stringify(input.errorState ?? "")};
    const certificateErrors = new Set();
    const updateLocation = () => {
      if (!uri || !security) return;
      uri.value = committedUrl;
      const secure = committedUrl.startsWith("https:") && !errorState;
      security.textContent = errorState === "certificate-error" ? ${JSON.stringify(t("oauthWindow.certificateError"))} : errorState === "load-error" ? ${JSON.stringify(t("oauthWindow.loadError"))} : secure ? ${JSON.stringify(t("oauthWindow.secure"))} : ${JSON.stringify(t("oauthWindow.insecure"))};
      security.dataset.security = errorState || (secure ? "https" : "http");
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
    ${input.nativeFrame ? "" : buildTitlebarButtonScript({ platform, title: input.title })}
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
  guardShell(window);
  const closePopups = (): void => {
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    popups.clear();
  };
  window.on("closed", closePopups);
  const updateLocation = (popup: BrowserWindow, url: string, errorState: AuthDocumentError = ""): void => {
    if (popup.isDestroyed()) return;
    const html = buildAuthWindowShellHtml({ title, url, partition, nativeFrame: true, chromeOnly: true, errorState });
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
          parent: window, width: 520, height: 720, autoHideMenuBar: true, frame: true,
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
            parent: window, x, y, width, height, autoHideMenuBar: true, frame: true,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
          });
          guardShell(child);
          const guest = new WebContentsView({ webContents });
          child.contentView.addChildView(guest);
          teardowns.push(new Promise<void>(resolve => webContents.once("destroyed", () => resolve())));
          const resize = (): void => {
            const { width, height } = child.getContentBounds();
            guest.setBounds({ x: 0, y: 64, width, height: Math.max(0, height - 64) });
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
          updateLocation(child, "");
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
