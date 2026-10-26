// External-link viewers expose no host APIs or captured cookies; the caller chooses in-app or system-browser routing. Use the persistent-browser user
// agent and flush cookies on close so quick teardown does not lose authenticated sessions.
import { BrowserWindow, session as electronSession, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { registerWindowEventListeners } from "./window-event-listeners.js";
import { getCommonChromeOptions } from "./window-chrome.js";
import { markAsWindowControlOwned } from "../ipc/window-control-registry.js";
import { markAsLinkOwned } from "./link-window-registry.js";
import {
  buildTitlebarCss,
  buildTitlebarHtml,
  buildTitlebarButtonScript,
} from "./window-titlebar-shell.js";
import { resolveAppIconPath } from "./app-icon.js";
import { escapeHtml } from "../shared/escape-html.js";
import { preloadPreferences } from "./preload-bundles.js";
import { applyBrowserSessionIdentity } from "./browser-user-agent.js";

// JSON escaping does not protect script tags; escape angle brackets so embedded text cannot close the script element.
// Exported for direct testing — the HTML-safety of this escaping is the security property that keeps the shell document injection-proof.
export function jsonForScriptBlock(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

// Encode titles separately for HTML and script sinks; HTML entities would display literally in textContent.
// Exported for direct testing of the two title sinks.
export function buildLinkWindowShellHtml(opts: {
  url: string;
  title: string;
  partition?: string;
  platform: NodeJS.Platform;
}): string {
  const platform = opts.platform;
  const url = jsonForScriptBlock(opts.url);
  const partition = jsonForScriptBlock(opts.partition ?? "");
  const titleLiteral = jsonForScriptBlock(opts.title);
  const titleBarHtml = buildTitlebarHtml({ platform, title: opts.title });
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src http: https:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <style>${buildTitlebarCss()}</style>
</head>
<body>
  ${titleBarHtml}
  <webview id="link-view" src="" partition=""></webview>
  <script>
    const url = ${url};
    const partition = ${partition};
    document.title = ${titleLiteral};
    const titleEl = document.getElementById("title");
    if (titleEl) titleEl.textContent = ${titleLiteral};
    const view = document.getElementById("link-view");
    if (partition) view.setAttribute("partition", partition);
    view.setAttribute("src", url);
    ${buildTitlebarButtonScript({ platform, title: opts.title })}
  </script>
</body>
</html>`;
}

export interface OpenLinkWindowOptions {
  // URL to load. MUST be `http(s):` — caller should validate before passing.
  url: string;
  // Window title. Defaults to "External Link".
  windowTitle?: string;
  // Optional Electron session partition. When omitted, Electron's default session is used (which is fine for a generic viewer — there is no cross-plugin
  // cookie exfiltration concern because no cookies are read back to plugin code).
  persistPartition?: string;
  // Initial window width. Defaults to 1024.
  width?: number;
  // Initial window height. Defaults to 768.
  height?: number;
}

// The dedicated viewer partition shares persistent sign-in behavior; deny permissions by default so reopening cannot accumulate site privileges.
export function applyPersistentBrowserUserAgent(persistPartition: string): void {
  const ses = electronSession.fromPartition(persistPartition);
  applyBrowserSessionIdentity(ses);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

// Flush cookies before teardown because batched writes can lose a just-completed login.
// Log flush failure without blocking window teardown.
async function flushPartitionCookies(persistPartition: string): Promise<void> {
  try {
    await electronSession.fromPartition(persistPartition).cookies.flushStore();
  } catch (err) {
    console.warn(
      `[ave] cookie flush failed for partition '${persistPartition}': ${(err as Error).message}`,
    );
  }
}

function isHttpNavigationUrl(targetUrl: string): boolean {
  try {
    const protocol = new URL(targetUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function attachLinkNavigationGuards(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (details) => {
    if (!isHttpNavigationUrl(details.url)) details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    if (!isHttpNavigationUrl(details.url)) details.preventDefault();
  });
}

// Resolve on load or normal user close; reject only failure to begin loading.
export async function openLinkWindow(
  parent: BrowserWindow | null | undefined,
  opts: OpenLinkWindowOptions,
): Promise<void> {
  if (opts.persistPartition) {
    applyPersistentBrowserUserAgent(opts.persistPartition);
  }

  const shellPreload = preloadPreferences("preload");
  const preloadExists = existsSync(shellPreload.preload);
  const shellTitle = opts.windowTitle ?? "External Link";
  // Frame settings mirror the main app window so traffic-light spacing stays uniform on macOS and Win/Linux gets the same frameless shell with our own titlebar buttons.
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    width: opts.width ?? 1024,
    height: opts.height ?? 768,
    title: shellTitle,
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    // Frame settings sourced from the shared `getCommonChromeOptions()` helper so traffic-light spacing stays uniform across every Ave window. See `src/main/window-chrome.ts`.
    ...getCommonChromeOptions(),
    webPreferences: {
      // The trusted shell needs titlebar IPC while remote content remains isolated in its own partitioned webview.
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // The host preload's sandbox always; the preload itself only when it was built.
      ...shellPreload,
      ...(preloadExists ? {} : { preload: undefined }),
    },
  });
  if (typeof win.setMenu === "function") win.setMenu(null);
  markAsWindowControlOwned(win.webContents);
  registerWindowEventListeners(win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (typeof params.src !== "string" || params.src !== opts.url) {
      event.preventDefault();
      return;
    }
    const prefs = webPreferences as Record<string, unknown>;
    delete prefs.preload;
    delete prefs.preloadURL;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInWorker = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.webSecurity = true;
    prefs.sandbox = true;
    prefs.webviewTag = false;
    if (opts.persistPartition) {
      prefs.partition = opts.persistPartition;
    }
  });
  win.webContents.on("did-attach-webview", (_event, contents) => {
    markAsLinkOwned(contents);
    attachLinkNavigationGuards(contents);
  });

  // Resolve when the page finishes loading or the user closes the window. We do NOT keep the promise pending for the lifetime of the window — plugins call
  // `openExternalUrl` and forget about it.
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    win.once("ready-to-show", () => {
      win.show();
      settle(resolve);
    });
    win.once("closed", () => {
      // Await the flush before resolving so an `app.quit()` that follows a user closing this window cannot tear the process down before the freshly-written
      // auth cookies reach disk. Best-effort: errors are already swallowed-with-warn inside `flushPartitionCookies`.
      const finish = () => settle(resolve);
      if (opts.persistPartition) {
        void flushPartitionCookies(opts.persistPartition).finally(finish);
      } else {
        finish();
      }
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => {
      // Negative codes that mean "navigation aborted because of a redirect / user action" are fine — only reject on hard load failures.
      if (code === -3 /* ABORTED */) return;
      settle(() => reject(new Error(`link-window load failed (${code}): ${desc}`)));
    });

    const shellHtml = buildLinkWindowShellHtml({
      url: opts.url,
      title: shellTitle,
      partition: opts.persistPartition,
      platform: process.platform,
    });
    win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shellHtml)}`)
      .catch((err) => {
        settle(() => reject(err));
      });
  });
}
