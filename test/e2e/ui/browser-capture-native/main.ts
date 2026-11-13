import { assertNativeBrowserState, clearNativeBrowserStorage } from "../native-browser-state.js";
import { app, BaseWindow, ipcMain, nativeImage, type WebContents } from "electron";
import { configureE2eWindowPolicy } from "../../../../src/main/e2e-window-policy.js";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "../../../../src/contract/app-contract.js";
import { registerMainWindow, unregisterMainWindow } from "../../../../src/main/app-state.js";
import { createMainWindowHost, type MainWindow } from "../../../../src/main/main-window-host.js";
import { createBrowserPageActions } from "../../../../src/main/browser/browser-actions.js";
import { browserCapturePixelRatio } from "../../../../src/main/browser/browser-capture-desktop.js";
import { disposeBrowserWorkspaceService } from "../../../../src/main/browser/browser-workspace-desktop.js";
import { browserTabRegistry } from "../../../../src/main/browser/browser-tab-registry.js";
import { trackBrowserGuest } from "../../../../src/main/browser/browser-guest-tracking.js";
import { BrowserNativeSurfaceHost } from "../../../../src/main/browser/browser-native-surfaces.js";
import { attachSideBrowserWebview, installSideBrowserPartitionPolicy } from "../../../../src/main/side-browser-webview.js";
import { browserOrigin } from "../../../../src/shared/browser-tools.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../../src/shared/side-browser.js";
import type { BrowserScreenshotOptions } from "../../../../src/shared/browser-capture.js";
import type { BrowserTabBindRequest } from "../../../../src/shared/browser-surface.js";
import { parseBrowserNativeSurfaceRequest } from "../../../../src/shared/browser-native-surface.js";
import { parseBrowserNativeInput } from "../../../../src/shared/browser-native-input.js";
import { DEFAULT_APPEARANCE } from "../../../../src/shared/appearance-settings.js";
import type { InitialAppearanceResult } from "../../../../src/shared/initial-appearance.js";
import type { BrowserActionTab } from "../../../../src/tools/browser-tools.js";
import type { CaptureNativeFixture, CaptureNativeResult } from "./contract.js";
import { isUniformJpeg, startBrowserPreview, type BrowserPreviewHandle } from "../../../../src/main/browser-observation-preview.js";

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
let win: MainWindow;
let guest: WebContents;
let tabId = "";
let requestId = "";
let preview: BrowserPreviewHandle | undefined;
let previewFrame: ReturnType<CaptureNativeFixture["previewFrame"]> = null;

async function stopPreview(): Promise<void> {
  await preview?.stop();
  preview = undefined;
  previewFrame = null;
}

async function clickHuman(): ReturnType<CaptureNativeFixture["clickHuman"]> {
  const tab = record();
  const origin = browserOrigin(guest.getURL());
  if (!origin) throw new Error("Capture fixture origin is unavailable");
  const lease = browserTabRegistry.acquireControl(tab, actor);
  const live = { tab, signal: tab.actions.signal, leaseId: lease.id,
    approval: { tabId, origin, documentId: tab.documentId, controlGeneration: tab.controlGeneration } };
  try {
    const snapshot = await actions.snapshot(live, {});
    const ref = /button "Human takeover target"[^\n]*\[ref=(e\d+)\]/.exec(snapshot.text)?.[1];
    if (!ref) throw new Error("Capture fixture click target is unavailable");
    await actions.click(live, ref);
    return guest.executeJavaScript("({ clicks: window.nativeState.humanClicks, trusted: window.lastHumanClickTrusted })");
  } finally { browserTabRegistry.releaseControl(tabId, lease.id); }
}

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
    response.end(page.replace("</style>", "#drag{background:#36a;color:white}body{background:linear-gradient(to bottom,#e5533d 0 480px,#2f78dc 480px 960px,#d6b527 960px 1440px,#914dc8 1440px 1920px,#00a65a 1920px)}</style>").replace('aria-label="Drag source">Drag source</div>', 'aria-label="Drag source"></div>')
      .replace("</script>", 'byId("human").addEventListener("click", event => { window.lastHumanClickTrusted = event.isTrusted; });</script>'));
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
  const pending = new Map<number, { method: string; executionContextId?: number; awaitPromise?: boolean }>();
  let nextRequestId = 0;
  const sendCommand = guest.debugger.sendCommand.bind(guest.debugger);
  const capturePage = guest.capturePage.bind(guest);
  guest.debugger.sendCommand = async (method, parameters, sessionId) => {
    const requestId = ++nextRequestId;
    pending.set(requestId, { method, ...(method === "Runtime.callFunctionOn" ? {
      executionContextId: parameters?.executionContextId,
      awaitPromise: parameters?.awaitPromise,
    } : {}) });
    try { return await sendCommand(method, parameters, sessionId); }
    finally { pending.delete(requestId); }
  };
  guest.capturePage = async (rect, options) => {
    const requestId = ++nextRequestId;
    pending.set(requestId, { method: "native-readback" });
    try { return await capturePage(rect, options); }
    finally { pending.delete(requestId); }
  };
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
  } catch (error) {
    console.error("Native capture failed", JSON.stringify({ pending: [...pending] }));
    throw error;
  } finally {
    guest.debugger.sendCommand = sendCommand;
    guest.capturePage = capturePage;
    browserTabRegistry.releaseControl(tabId, lease.id);
  }
}

let origin = "";
let nativeSurfaces: BrowserNativeSurfaceHost | undefined;

async function reset(): Promise<void> {
  await stopPreview();
  if (guest && !guest.isDestroyed()) guest.setZoomFactor(1);
  nativeSurfaces?.dispose();
  nativeSurfaces = undefined;
  disposeBrowserWorkspaceService();
  for (const window of BaseWindow.getAllWindows()) {
    browserTabRegistry.releaseWindow(window.id);
    window.destroy();
  }
  await clearNativeBrowserStorage(AVE_SIDE_BROWSER_PARTITION);
  for (const channel of [CHANNELS.browser.bindTab, CHANNELS.browser.nativeSurface, CHANNELS.browser.getSessionBindings]) ipcMain.removeHandler(channel);
  ipcMain.removeAllListeners(CHANNELS.browser.nativeInput);
  ipcMain.removeAllListeners(CHANNELS.settings.initialAppearance);
  tabId = "";
  requestId = "";
  browserTabRegistry.setRendererLink({
    isWindowVisible: (windowId) => windowId === win.id && !win.isDestroyed() && win.isVisible(),
    sendTabOp: (_windowId, request) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
      if (request.op === "new") requestId = request.requestId;
      win.webContents.send(CHANNELS.browser.tabOp, request);
      return true;
    },
    sendControl: () => {},
    sendSessionBindings: (_windowId, state) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.browser.sessionBindingsChanged, state);
    },
  });
  win = createMainWindowHost({ width: 1180, height: 860, show: false, focusable: false },
    { zoomFactor: 1 });
  registerMainWindow(win, "primary");
  const owner = win;
  const windowId = owner.id;
  ipcMain.on(CHANNELS.settings.initialAppearance, (event) => {
    const frame = event.senderFrame;
    const result: InitialAppearanceResult = !owner.isDestroyed()
      && event.sender === owner.webContents
      && frame !== null
      && frame === owner.webContents.mainFrame
      && frame.url === `${origin}/host?requestId=${encodeURIComponent(requestId)}`
      ? { ok: true, appearance: DEFAULT_APPEARANCE, glass: "unsupported" }
      : { ok: false, error: "unauthorized-frame" };
    event.returnValue = result;
  });
  owner.once("closed", () => { browserTabRegistry.releaseWindow(windowId); unregisterMainWindow(owner); });
  const hostErrors: string[] = [];
  win.webContents.on("console-message", (event) => {
    process.stderr.write(`[capture-host] ${event.message}\n`);
    if (event.message.includes("Unable to load preload script") || event.message.includes("Uncaught Error:")) hostErrors.push(event.message);
  });
  const opening = browserTabRegistry.requestTabOp(win.id, { op: "new", url: `${origin}/page`, actor, active: true });
  const loading = win.loadURL(`${origin}/host?requestId=${encodeURIComponent(requestId)}`);
  installSideBrowserPartitionPolicy();
  const surfaces = new BrowserNativeSurfaceHost({
    windowForId: id => id === win.id && !win.isDestroyed() ? win : undefined,
    authorizeCreate: (windowId, tabId, requestId) => browserTabRegistry.authorizeNativeSurface(windowId, tabId, requestId),
    attach: (contents, owner) => {
      guest = contents;
      trackBrowserGuest(contents, owner.id, { kind: "native-view" });
      attachSideBrowserWebview(contents, owner);
    },
    bind: (windowId, request) => browserTabRegistry.bindTab(windowId, request),
    changed: (_windowId, surface, tabId) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.browser.nativeSurfaceChanged, { tabId, surface });
    },
    inputStateChanged: (_windowId, state) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.browser.nativeInputState, state);
    },
    userFocus: (guestId, explicit) => browserTabRegistry.userFocus(guestId, explicit),
    userNavigate: (windowId, tabId) => { browserTabRegistry.stop(windowId, tabId); },
  });
  nativeSurfaces = surfaces;
  ipcMain.on(CHANNELS.browser.nativeInput, (event, payload: unknown) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    const input = parseBrowserNativeInput(payload);
    if (input) surfaces.input(win.id, input);
  });
  ipcMain.handle(CHANNELS.browser.bindTab, (event, request: BrowserTabBindRequest) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Capture fixture sender is unauthorized");
    return browserTabRegistry.bindTab(win.id, request);
  });
  ipcMain.handle(CHANNELS.browser.nativeSurface, (event, payload: unknown) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Capture fixture sender is unauthorized");
    const request = parseBrowserNativeSurfaceRequest(payload);
    return request ? surfaces.request(win.id, request) : { ok: false, error: "bad-request" };
  });
  ipcMain.handle(CHANNELS.browser.getSessionBindings, (event) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Capture fixture sender is unauthorized");
    return browserTabRegistry.sessionBindingsState(win.id);
  });
  await loading;
  if (!await win.webContents.executeJavaScript("Boolean(window.aveApi?.browserTabs?.nativeSurface)")) throw new Error("Capture fixture host preload is unavailable");
  if (hostErrors.length > 0) throw new Error(`Capture fixture host startup failed: ${hostErrors.join("; ")}`);
  win.showInactive();
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
  const fixture: CaptureNativeFixture = {
    ready: true,
    get pageUrl() { return `${origin}/page`; },
    get targetId() { return guest.id; },
    get windowId() { return win.id; },
    capture, reset, clickHuman,
    startPreview: () => {
      previewFrame = null;
      preview = startBrowserPreview(guest, {
        frame: frame => { previewFrame = frame; preview?.rendered(frame.frame); },
        updating: () => { previewFrame = null; },
        ended: error => { console.error(error); },
        isBlank: data => isUniformJpeg(data, buffer => {
          const image = nativeImage.createFromBuffer(buffer);
          return { bitmap: image.toBitmap(), ...image.getSize() };
        }),
      });
    },
    previewFrame: () => previewFrame,
    stopPreview,
    assertClean: async () => assertNativeBrowserState(win, guest, rendererTabId),
    close: async () => {
      await stopPreview();
      if (!guest.isDestroyed()) guest.stop();
      nativeSurfaces?.dispose();
      disposeBrowserWorkspaceService();
      if (!win.isDestroyed()) win.destroy();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
  (globalThis as unknown as { captureNativeFixture: CaptureNativeFixture }).captureNativeFixture = fixture;
}).catch((error) => { console.error(error); app.exit(1); });
