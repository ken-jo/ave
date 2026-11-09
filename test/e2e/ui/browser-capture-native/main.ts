import { assertNativeBrowserState, clearNativeBrowserStorage } from "../native-browser-state.js";
import { app, BrowserWindow, ipcMain, nativeImage, type WebContents } from "electron";
import { configureE2eWindowPolicy } from "../../../../src/main/e2e-window-policy.js";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createBrowserPageActions } from "../../../../src/main/browser/browser-actions.js";
import { browserCapturePixelRatio } from "../../../../src/main/browser/browser-capture-desktop.js";
import { browserTabRegistry } from "../../../../src/main/browser/browser-tab-registry.js";
import { trackBrowserGuest } from "../../../../src/main/browser/browser-guest-tracking.js";
import { browserOrigin } from "../../../../src/shared/browser-tools.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../../src/shared/side-browser.js";
import type { BrowserScreenshotOptions } from "../../../../src/shared/browser-capture.js";
import type { BrowserTabBindRequest } from "../../../../src/shared/browser-surface.js";
import type { BrowserActionTab } from "../../../../src/tools/browser-tools.js";
import type { CaptureNativeFixture, CaptureNativeResult } from "./contract.js";

configureE2eWindowPolicy();
// Window replacement between tests keeps this worker-owned process alive.
app.on("window-all-closed", () => {});

function requiredPath(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error("Capture fixture paths are required");
  return path;
}

const assets = requiredPath("AVE_CAPTURE_FIXTURE_ASSETS");
const runtime = requiredPath("AVE_CAPTURE_FIXTURE_RUNTIME");
const pagePath = requiredPath("AVE_CAPTURE_FIXTURE_PAGE");
const actor = { sessionId: "capture-native-conversation" };
const rendererTabId = "capture-native-tab";
let win: BrowserWindow;
let guest: WebContents;
let tabId = "";
let requestId = "";

const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/host")) {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><meta charset="utf-8"><title>Browser capture fixture</title><style>body{margin:0;background:#e8edf2;font:16px sans-serif}header{padding:20px}#slot{position:absolute;left:230px;top:70px;width:900px;height:650px}</style><header>Trusted capture fixture <input id="composer" aria-label="Host composer"></header><div id="root"></div><div id="slot"></div><script src="/renderer.js"></script>');
  } else if (request.url === "/renderer.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(await fs.readFile(join(assets, "renderer.js")));
  } else {
    response.setHeader("content-type", "text/html");
    const page = await fs.readFile(pagePath, "utf8");
    response.end(page.replace("</style>", "#drag{background:#36a;color:white}body{background:linear-gradient(to bottom,#e5533d 0 480px,#2f78dc 480px 960px,#d6b527 960px 1440px,#914dc8 1440px 1920px,#00a65a 1920px)}</style>").replace('aria-label="Drag source">Drag source</div>', 'aria-label="Drag source"></div>'));
  }
});

const actions = createBrowserPageActions(browserTabRegistry, browserOrigin, () => {
  const bounds = win.getContentBounds();
  return { x: bounds.x, y: bounds.y, windowId: win.id };
}, {
  decodePng: (png) => nativeImage.createFromBuffer(Buffer.from(png, "base64")),
  record: () => {},
}, browserCapturePixelRatio);

function record() {
  const tab = browserTabRegistry.liveTab(tabId);
  if (!tab) throw new Error("Capture fixture tab disappeared");
  const origin = tab.guest ? browserOrigin(tab.guest.getURL()) : null;
  if (tab.opener !== "agent" || tab.owner?.sessionId !== actor.sessionId || origin !== null && tab.agentOrigin !== origin) {
    throw new Error("Capture fixture tab lost its approved agent ownership");
  }
  return tab;
}

async function capture(options: BrowserScreenshotOptions, zoom = 1): Promise<CaptureNativeResult> {
  guest.setZoomFactor(zoom);
  await actions.prepare({ tab: record(), signal: new AbortController().signal });
  const tab = record();
  const origin = browserOrigin(guest.getURL());
  if (!origin) throw new Error("Capture fixture page origin is unavailable");
  const lease = browserTabRegistry.acquireControl(tab, actor);
  const live: BrowserActionTab<WebContents> = { tab, signal: tab.actions.signal, leaseId: lease.id,
    approval: { tabId, origin, documentId: tab.documentId, controlGeneration: tab.controlGeneration } };
  try {
    let ref: string | undefined;
    if (options.ref) {
      const snapshot = await actions.snapshot(live, {});
      const line = snapshot.text.split("\n").find((candidate) => candidate.includes('"Drag source"'));
      ref = line && /\[ref=(e\d+)\]/.exec(line)?.[1];
      if (!ref) throw new Error("Capture fixture ref is unavailable");
    }
    const image = await actions.screenshot(live, { ...options, ...(ref ? { ref } : {}) });
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
    const dimensions = decoded.getSize();
    const state = await guest.executeJavaScript(`(() => {
      const element = document.getElementById('drag').getBoundingClientRect();
      const bottom = document.getElementById('bottom').getBoundingClientRect();
      if (!visualViewport) throw new Error('Capture fixture viewport is unavailable');
      return { viewport: {width:visualViewport.width,height:visualViewport.height}, content: {width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
        element:{width:element.width,height:element.height}, bottom:{x:bottom.x+scrollX+bottom.width/2,y:bottom.y+scrollY+bottom.height/2} };
    })()` ) as { viewport: { width: number; height: number }; content: { width: number; height: number }; element: { width: number; height: number }; bottom: { x: number; y: number } };
    const x = Math.min(dimensions.width - 1, Math.floor(state.bottom.x * dimensions.width / state.content.width));
    const y = Math.min(dimensions.height - 1, Math.floor(state.bottom.y * dimensions.height / state.content.height));
    const offset = (y * dimensions.width + x) * 4;
    const bitmap = decoded.toBitmap();
    const pixel = (position: number) => {
      const red = bitmap[position + 2], green = bitmap[position + 1], blue = bitmap[position];
      if (red === undefined || green === undefined || blue === undefined) throw new Error("Capture fixture pixel lies outside the decoded image");
      return [red, green, blue];
    };
    return { data: image.data, dimensions, viewport: state.viewport, content: state.content, element: state.element,
      bandPixelsRGB: [200, 500, 700, 980, 1200, 1460, 1700, 1940, 2200].map((y) => pixel((dimensions.width * Math.min(dimensions.height - 1, y) + Math.min(dimensions.width - 1, 700)) * 4)),
      bottomPixelRGB: pixel(offset), elementPixelsRGB: [0.25, 0.5, 0.75].map((fraction) => pixel((dimensions.width * Math.floor(dimensions.height * fraction) + Math.floor(dimensions.width / 2)) * 4)), truncated: image.truncated };
  } finally { browserTabRegistry.releaseControl(tabId, lease.id); }
}

let origin = "";

async function reset(): Promise<void> {
  if (guest && !guest.isDestroyed()) guest.setZoomFactor(1);
  for (const window of BrowserWindow.getAllWindows()) {
    browserTabRegistry.releaseWindow(window.id);
    window.destroy();
  }
  await clearNativeBrowserStorage(AVE_SIDE_BROWSER_PARTITION);
  ipcMain.removeHandler("capture-fixture-bind");
  tabId = "";
  requestId = "";
  win = new BrowserWindow({ width: 1180, height: 860, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(assets, "preload.cjs") } });
  win.showInactive();
  const windowId = win.id;
  win.once("closed", () => browserTabRegistry.releaseWindow(windowId));
  win.webContents.on("console-message", (event) => { process.stderr.write(`[capture-host] ${event.message}\n`); });
  win.webContents.on("will-attach-webview", (_event, preferences) => {
    preferences.contextIsolation = true; preferences.sandbox = true; preferences.nodeIntegration = false; delete preferences.preload;
  });
  win.webContents.on("did-attach-webview", (_event, contents) => { guest = contents; guest.setZoomFactor(1); trackBrowserGuest(guest, win.id); });
  ipcMain.handle("capture-fixture-bind", (event, request: BrowserTabBindRequest) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Capture fixture sender is unauthorized");
    return browserTabRegistry.bindTab(win.id, request);
  });
  browserTabRegistry.setRendererLink({
    isWindowVisible: (windowId) => windowId === win.id && !win.isDestroyed() && win.isVisible(),
    sendTabOp: (_windowId, request) => {
      if (request.op === "new") requestId = request.requestId;
      win.webContents.send("capture-fixture-tab-op", request);
      return true;
    },
    sendControl: () => {},
  });
  const opening = browserTabRegistry.requestTabOp(win.id, { op: "new", url: `${origin}/page`, actor, active: true });
  await win.loadURL(`${origin}/host?requestId=${encodeURIComponent(requestId)}`);
  const opened = await opening;
  if (!opened.ok) throw new Error(`Capture fixture opening failed: ${opened.error}`);
  tabId = opened.tabId;
  browserTabRegistry.setActiveSurface(win.id, { kind: "browser", tabId: rendererTabId });
  await actions.prepare({ tab: record(), signal: new AbortController().signal });
  const bootstrap = browserTabRegistry.acquireControl(record(), actor);
  try { await actions.navigate({ tab: record(), signal: record().actions.signal, leaseId: bootstrap.id }, `${origin}/page`, origin); }
  finally { browserTabRegistry.releaseControl(tabId, bootstrap.id); }
  guest.setZoomFactor(1);
  win.webContents.setZoomFactor(1);
}

void app.whenReady().then(async () => {
  app.setPath("userData", join(runtime, "profile"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Capture fixture server is unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  await reset();
  const fixture: CaptureNativeFixture = { ready: true, capture, reset, assertClean: async () => assertNativeBrowserState(win, guest, rendererTabId), close: async () => {
    guest.stop(); win.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
  (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture = fixture;
}).catch((error) => { console.error(error); app.exit(1); });
