import { randomBytes } from "node:crypto";
import { BrowserWindow, clipboard, session, shell, type BaseWindow } from "electron";
import type { DeviceCodePresentation, DeviceCodePrompt } from "../auth/oauth-device-code.js";
import { t } from "../i18n/index.js";
import { escapeHtml } from "../shared/escape-html.js";
import { markAsAuthOwned } from "./auth-window-registry.js";
import { isBackgroundE2eRuntime, showWindowForRuntime } from "./e2e-window-presentation.js";

function verificationUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (raw.length > 8192 || url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Invalid device verification URL");
  }
  return url.href;
}

interface DeviceCodeActions {
  copyCode: string;
  copyUri: string;
  openUri: string;
  openComplete: string;
  cancel: string;
}

/** A static host document has no preload, script, remote content or arbitrary action arguments. */
export function buildDeviceCodeDialogHtml(prompt: DeviceCodePrompt, actions: DeviceCodeActions): string {
  const link = (action: string, label: string, className = "button"): string =>
    `<a class="${className}" role="button" href="${escapeHtml(action)}">${escapeHtml(label)}</a>`;
  return `<!doctype html>
<html lang="${escapeHtml(t("deviceCode.language"))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none';">
<title>${escapeHtml(t("deviceCode.title"))}</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; background: #f8fafc; color: #182233; }
* { box-sizing: border-box; }
body { margin: 0; padding: 30px; font-size: 14px; line-height: 1.5; }
h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.25; }
p { margin: 0 0 20px; color: #4b586d; }
.label { display: block; color: #4b586d; font-size: 12px; margin-bottom: 8px; }
.code-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid #cbd5e1; background: #fff; padding: 16px; border-radius: 12px; margin-bottom: 22px; }
code { font-family: ui-monospace, monospace; font-size: 28px; font-weight: 650; letter-spacing: .1em; overflow-wrap: anywhere; user-select: text; }
.uri { display: block; color: #235fc7; overflow-wrap: anywhere; user-select: text; margin-bottom: 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 22px; }
.button { display: inline-block; text-decoration: none; color: #182233; border: 1px solid #bcc9db; background: #fff; padding: 8px 13px; border-radius: 8px; font-size: 13px; font-weight: 550; }
.button:hover { background: #eaf0f9; }
.button:focus-visible { outline: 3px solid #2563eb; outline-offset: 3px; }
.primary { background: #235fc7; border-color: #235fc7; color: #fff; }
.primary:hover { background: #17489e; }
footer { border-top: 1px solid #dbe3ef; padding-top: 18px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.waiting { color: #4b586d; font-size: 12px; }
@media (prefers-color-scheme: dark) { :root { background: #161b24; color: #e5ebf5; } p, .label, .waiting { color: #a8b6cb; } .code-row, .button { background: #222b39; border-color: #46556c; color: #e5ebf5; } .uri { color: #8cb7ff; } .button:hover { background: #303f54; } .primary { background: #235fc7; color: #fff; } footer { border-color: #35435a; } }
</style>
</head>
<body>
<main aria-labelledby="device-title">
<h1 id="device-title">${escapeHtml(t("deviceCode.title"))}</h1>
<p>${escapeHtml(t("deviceCode.instructions"))}</p>
<span class="label">${escapeHtml(t("deviceCode.codeLabel"))}</span>
<div class="code-row"><code id="device-user-code">${escapeHtml(prompt.userCode)}</code>${link(actions.copyCode, t("deviceCode.copyCode"))}</div>
<span class="label">${escapeHtml(t("deviceCode.uriLabel"))}</span>
<a class="uri" href="${escapeHtml(actions.openUri)}">${escapeHtml(prompt.verificationUri)}</a>
<div class="actions">${link(actions.openUri, t("deviceCode.openUri"), "button primary")}${link(actions.copyUri, t("deviceCode.copyUri"))}${prompt.verificationUriComplete ? link(actions.openComplete, t("deviceCode.openComplete")) : ""}</div>
<footer><span class="waiting" role="status">${escapeHtml(t("deviceCode.waiting"))}</span>${link(actions.cancel, t("common.cancel"))}</footer>
</main>
</body>
</html>`;
}

/** Only a live desktop owner can present a human authorization request. */
export function createDeviceCodePresentation(parentWindow: () => BaseWindow | null): DeviceCodePresentation {
  return {
    available: () => {
      const parent = parentWindow();
      return parent !== null && !parent.isDestroyed();
    },
    async show(prompt, controller) {
      const parent = parentWindow();
      if (!parent || parent.isDestroyed()) {
        throw new Error("Device sign-in needs a person. Authenticate in the desktop app before running unattended; do not retry here.");
      }
      if (controller.signal.aborted) throw new Error("Device sign-in canceled");
      if (typeof prompt.userCode !== "string" || !prompt.userCode || prompt.userCode.length > 512 ||
        !Number.isFinite(prompt.expiresAt) || prompt.expiresAt <= Date.now()) throw new Error("Invalid device sign-in prompt");
      const uri = verificationUrl(prompt.verificationUri);
      const completeUri = prompt.verificationUriComplete === undefined ? undefined : verificationUrl(prompt.verificationUriComplete);
      const actionBase = `https://device-code.invalid/${randomBytes(24).toString("hex")}`;
      const actions: DeviceCodeActions = {
        copyCode: `${actionBase}/copy-code`, copyUri: `${actionBase}/copy-uri`,
        openUri: `${actionBase}/open-uri`, openComplete: `${actionBase}/open-complete`, cancel: `${actionBase}/cancel`,
      };
      const html = buildDeviceCodeDialogHtml(prompt, actions);
      const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      const partition = `device-code:${randomBytes(16).toString("hex")}`;
      const isolatedSession = session.fromPartition(partition);
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "file://*/*"] }, (_details, callback) => callback({ cancel: true }));
      const window = new BrowserWindow({
        parent, modal: !isBackgroundE2eRuntime(), show: false, width: 600, height: 470,
        minWidth: 460, minHeight: 430, resizable: true, minimizable: false, maximizable: false,
        title: t("deviceCode.title"), autoHideMenuBar: true,
        webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false, devTools: false },
      });
      window.setMenu(null);
      markAsAuthOwned(window.webContents);
      let finished = false;
      const close = (): void => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener("abort", close);
        parent.off("closed", cancel);
        if (!window.isDestroyed()) window.destroy();
      };
      const cancel = (): void => { controller.abort(); close(); };
      controller.signal.addEventListener("abort", close, { once: true });
      parent.once("closed", cancel);
      window.once("closed", () => { if (!finished) cancel(); });
      window.webContents.once("render-process-gone", cancel);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      window.webContents.on("will-redirect", (event) => event.preventDefault());
      window.webContents.on("will-frame-navigate", (event) => {
        if (!event.isMainFrame) event.preventDefault();
      });
      window.webContents.on("will-navigate", (event) => {
        event.preventDefault();
        const contents = window.webContents;
        if (finished || contents.isDestroyed() || contents.getURL() !== documentUrl || !event.isMainFrame ||
          event.frame !== contents.mainFrame || event.initiator !== contents.mainFrame) return;
        if (event.url === actions.cancel) cancel();
        else if (event.url === actions.copyCode) void clipboard.writeText(prompt.userCode).catch(cancel);
        else if (event.url === actions.copyUri) void clipboard.writeText(uri).catch(cancel);
        else if (event.url === actions.openUri || (completeUri !== undefined && event.url === actions.openComplete)) {
          const target = event.url === actions.openUri ? uri : completeUri;
          if (target === undefined) throw new Error("Device verification link is unavailable");
          void shell.openExternal(target).catch(() => { cancel(); });
        }
      });
      try {
        await window.loadURL(documentUrl);
        if (controller.signal.aborted || finished) throw new Error("Device sign-in canceled");
        showWindowForRuntime(window);
        return close;
      } catch (error) {
        cancel();
        throw error;
      }
    },
  };
}
