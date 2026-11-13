import { assertNativeBrowserState, clearNativeBrowserStorage } from "../native-browser-state.js";
import { configureE2eWindowPolicy } from "../../../../src/main/e2e-window-policy.js";
import { isBackgroundE2eRuntime, whenFocusEmulated } from "../../../../src/main/e2e-window-presentation.js";
import { app, BrowserWindow, WebContentsView, nativeImage, type WebContents } from "electron";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createBrowserPageActions } from "../../../../src/main/browser/browser-actions.js";
import { browserCapturePixelRatio } from "../../../../src/main/browser/browser-capture-desktop.js";
import { browserTabRegistry } from "../../../../src/main/browser/browser-tab-registry.js";
import { trackBrowserGuest } from "../../../../src/main/browser/browser-guest-tracking.js";
import { disposeBrowserUploads } from "../../../../src/main/browser/browser-upload.js";
import { browserOrigin } from "../../../../src/shared/browser-tools.js";
import type { BrowserActionTab } from "../../../../src/tools/browser-tools.js";
import type { NativeAction, NativeActionResult, NativeBrowserFixture, NativeOracle } from "./contract.js";

function fixturePath(key: string): string {
  const path = process.env[key];
  if (!path) throw new Error("Native fixture paths are required");
  return path;
}

const fixtureDir = fixturePath("AVE_NATIVE_FIXTURE_DIR");
const runtimeDir = fixturePath("AVE_NATIVE_FIXTURE_RUNTIME");
const preload = fixturePath("AVE_NATIVE_FIXTURE_PRELOAD");
const fixtureMode = process.env.AVE_NATIVE_FIXTURE_MODE;
if (fixtureMode !== "cdp" && fixtureMode !== "foreground") throw new Error("Native fixture mode is required");
configureE2eWindowPolicy();
// Window replacement between tests keeps this worker-owned process alive.
app.on("window-all-closed", () => {});
if (fixtureMode === "foreground" && process.platform === "darwin") app.setActivationPolicy("regular");
const actor = { sessionId: "native-fixture-conversation" };
const rendererTabId = "native-fixture-browser";
const NATIVE_BROWSER_PARTITION = "native-browser-actions-fixture";
const originalBytes = "immutable fixture bytes\n";
let received: { bytes: string; name: string } | null = null;
let guest: WebContents;
let tabId = "";
let win: BrowserWindow;
let requestId = "";
let pendingWindowStartup = 0;
const nativeEvents: { event: string; type: string; modifiers: number; raw: Record<string, unknown> }[] = [];
type NativeInputEventName = "before-input-event" | "before-mouse-event" | "input-event";
interface NativeInputObservation { readonly type: string; readonly _modifiers?: number }

function isNativeInputObservation(input: unknown): input is NativeInputObservation {
  return input !== null && typeof input === "object" && "type" in input && typeof input.type === "string"
    && (!("_modifiers" in input) || input._modifiers === undefined || typeof input._modifiers === "number");
}

function recordNativeInput(event: NativeInputEventName, input: unknown): void {
  if (!isNativeInputObservation(input)) throw new Error("Native fixture received an invalid input observation");
  const raw: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(input)) {
    const value: unknown = Reflect.get(input, key);
    if (value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value)) raw[key] = value;
  }
  nativeEvents.push({ event, type: input.type, modifiers: input._modifiers ?? 0, raw });
}
const server = createServer(async (request, response) => {
  if (request.url === "/host") {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Native action host</title><style>body{margin:0;background:#e8edf2;font:16px sans-serif}aside{width:210px;padding:18px}#slot{position:absolute;left:230px;top:70px;width:904px;height:724px;border:2px solid #345}</style><aside>Trusted fixture chrome<input id="composer" aria-label="Host composer" autofocus></aside><div id="slot"></div><script>window.nativeFixtureChrome.onTabOp(request => { if (request.op === "restore-focus") document.getElementById("composer").focus(); });</script>`);
    return;
  }
  if (request.url === "/upload" && request.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024) { response.writeHead(413); response.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    received = { bytes: Buffer.concat(chunks).toString("utf8"), name: decodeURIComponent(String(request.headers["x-fixture-name"] ?? "")) };
    response.end("fixture bytes received");
    return;
  }
  response.setHeader("content-type", "text/html");
  if (request.url === "/pending-resource") { response.write("pending"); return; }
  if (request.url === "/readable") {
    const page = await fs.readFile(join(fixtureDir, "page.html"), "utf8");
    response.end(`${page}<main><h1>Fixture news headline</h1><p>Readable story text.</p><p hidden>Hidden story text.</p></main><img src="/pending-resource">`);
    return;
  }
  response.end(await fs.readFile(join(fixtureDir, "page.html"), "utf8"));
});

const oracleScript = `(() => {
  const state = window.nativeState;
  const point = document.getElementById('human').getBoundingClientRect();
  const bottom = document.getElementById('bottom').getBoundingClientRect();
  return { ...state, selected: document.getElementById('choice').value,
    slider: document.getElementById('slider').value,
    upload: document.getElementById('file').files[0] ? { name: document.getElementById('file').files[0].name, bytes: document.getElementById('file').files[0].size } : null,
    scrollTop: document.getElementById('nested').scrollTop, pageY: scrollY,
    viewport: {width: innerWidth, height: innerHeight},
    content: {width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight},
    bottom: {x: bottom.x + scrollX, y: bottom.y + scrollY, width: bottom.width, height: bottom.height},
    humanPoint: {x: point.x + point.width / 2, y: point.y + point.height / 2}, url: location.href };
})()`;

function record() {
  const tab = browserTabRegistry.liveTab(tabId);
  if (!tab) throw new Error("Native fixture tab disappeared");
  return tab;
}

const actions = createBrowserPageActions(browserTabRegistry, browserOrigin, () => {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getContentBounds();
  return { x: bounds.x, y: bounds.y, windowId: win.id };
}, {
  decodePng: (png) => nativeImage.createFromBuffer(Buffer.from(png, "base64")),
  // The fixture has no session preview panel to keep a capture for.
  record: () => {},
}, browserCapturePixelRatio);

async function read(value?: unknown, error?: { code: string; message: string }): Promise<NativeActionResult> {
  const tab = record();
  if (guest.isLoading()) await actions.settle({ tab, signal: new AbortController().signal });
  return { ok: error === undefined, ...(error ? { error } : {}), ...(value === undefined ? {} : { value }),
    oracle: await guest.executeJavaScript(oracleScript) as NativeOracle,
    mode: tab.controlMode, generation: tab.controlGeneration, owner: tab.owner?.sessionId ?? null,
    received, focus: { window: win.isFocused(), guest: guest.isFocused(), mainFrame: guest.focusedFrame === guest.mainFrame,
      host: await win.webContents.executeJavaScript('({focused:document.hasFocus(),active:document.activeElement.tagName,bridge:typeof window.nativeFixtureChrome,visibility:document.visibilityState})') },
    nativeEvents: nativeEvents.slice(-100) };
}

async function run(action: NativeAction): Promise<NativeActionResult> {
  try {
    if (action === "resume") return read({ resumed: browserTabRegistry.resume(win.id, rendererTabId) });
    if (action === "edit-original") {
      await fs.writeFile(join(runtimeDir, "selected.txt"), "edited original after staging\n");
      return read({ originalBytes: await fs.readFile(join(runtimeDir, "selected.txt"), "utf8") });
    }
    await actions.prepare({ tab: record(), signal: new AbortController().signal });
    const tab = record();
    const lease = browserTabRegistry.acquireControl(tab, actor);
    if (action === "hold-control") return read({ lease: true });
    const live: BrowserActionTab<WebContents> = { tab, signal: tab.actions.signal, leaseId: lease.id,
      approval: { tabId, origin: browserOrigin(guest.getURL())!, documentId: tab.documentId, controlGeneration: tab.controlGeneration } };
    try {
      const snapshot = await actions.snapshot(live, {});
      const ref = (label: string) => {
        const line = snapshot.text.split("\n").find((candidate) => candidate.includes(JSON.stringify(label)) && /\[ref=e\d+\]/.test(candidate));
        const found = line && /\[ref=(e\d+)\]/.exec(line)?.[1];
        if (!found) throw new Error(`Fixture ref not found for ${label}: ${snapshot.text}`);
        return found;
      };
      let value: unknown;
      switch (action) {
        case "read-content": {
          const destination = new URL("/readable", guest.getURL()).href;
          const destinationOrigin = browserOrigin(destination);
          if (!destinationOrigin) throw new Error("Fixture origin is unavailable");
          const readiness = await actions.navigate({ tab, signal: tab.actions.signal, leaseId: lease.id }, destination, destinationOrigin);
          const current = { tab: record(), signal: record().actions.signal, leaseId: lease.id };
          const text = await actions.readText(current);
          value = { readiness, text, loading: guest.isLoading() };
          // The independent DOM oracle waits for full load; release only after recording tool readiness and text.
          guest.stop();
          break;
        }
        case "hover": await actions.hover(live, ref("Hover target")); break;
        case "drag": await actions.drag(live, ref("Drag source"), ref("Drop target")); break;
        case "slider": await actions.drag(live, ref("Native slider"), ref("Slider end")); break;
        case "select": await actions.select(live, ref("Native choice"), "b"); break;
        case "select-navigation": await actions.select(live, ref("Navigation choice"), "b"); break;
        case "scroll": await actions.scroll(live, ref("Nested scroll target"), "down", 500); break;
        case "navigate": await actions.click(live, ref("Navigate fixture")); await actions.settle({ tab, signal: new AbortController().signal }); break;
        case "submit": await actions.click(live, ref("Send selected bytes")); break;
        case "screenshot": {
          const image = await actions.screenshot(live, { fullPage: true });
          const captured = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
          const dimensions = captured.getSize();
          const state = await guest.executeJavaScript(oracleScript) as NativeOracle;
          const x = Math.floor((state.bottom.x + state.bottom.width / 2) * dimensions.width / state.content.width);
          const y = Math.floor((state.bottom.y + state.bottom.height / 2) * dimensions.height / state.content.height);
          const offset = (y * dimensions.width + x) * 4;
          const pixels = captured.toBitmap();
          value = { ...image, dimensions, bottomPixelRGB: [pixels[offset + 2], pixels[offset + 1], pixels[offset]] };
          break;
        }
        case "upload": case "cancel-upload": {
          value = await actions.upload(live, ref("Upload fixture bytes"), {
            windowId: win.id, sessionId: actor.sessionId,
            // Test boundary: native dialog interaction is not automated. The
            // shipping broker still stages and assigns the chosen fixture file.
            pickFiles: async (request) => {
              if (request.windowId !== win.id || request.sessionId !== actor.sessionId || request.tabId !== tabId
                || request.documentId !== tab.documentId || request.controlGeneration !== tab.controlGeneration) throw new Error("Picker destination mismatch");
              return action === "cancel-upload" ? null : [await fs.realpath(join(runtimeDir, "selected.txt"))];
            },
          });
          break;
        }
      }
      return await read(value);
    } finally { browserTabRegistry.releaseControl(tabId, lease.id); }
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return read(undefined, { code: failure.code ?? "fixture-action-failed", message: failure.message ?? String(error) });
  }
}

let origin = "";

async function reset(): Promise<void> {
  if (guest && !guest.isDestroyed()) guest.setZoomFactor(1);
  const destroyed = guest && !guest.isDestroyed() ? once(guest, "destroyed") : undefined;
  const windows = BrowserWindow.getAllWindows();
  // A newly loaded extra window may still own its startup protocol command.
  // Drain that acknowledgement before destroying the window during reset.
  if (isBackgroundE2eRuntime()) {
    await Promise.all(windows.map(async window => {
      pendingWindowStartup++;
      try {
        if (!await whenFocusEmulated(window.webContents)) throw new Error("Native fixture window startup ended before reset");
      } finally { pendingWindowStartup--; }
    }));
  }
  for (const window of windows) {
    browserTabRegistry.releaseWindow(window.id);
    window.destroy();
  }
  await destroyed;
  server.closeAllConnections();
  await clearNativeBrowserStorage(NATIVE_BROWSER_PARTITION);
  received = null;
  nativeEvents.length = 0;
  requestId = "";
  tabId = "";
  await fs.writeFile(join(runtimeDir, "selected.txt"), originalBytes);
  if (fixtureMode === "foreground" && process.platform === "darwin") {
    const dock = app.dock;
    if (!dock) throw new Error("Native fixture dock is unavailable");
    await dock.show();
  }
  win = new BrowserWindow({ width: 1180, height: 860, x: 40, y: 40, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload } });
  if (fixtureMode === "foreground") win.show(); else win.showInactive();
  const owner = win;
  const windowId = win.id;
  win.once("closed", () => browserTabRegistry.releaseWindow(windowId));
  browserTabRegistry.setRendererLink({
    isWindowVisible: (windowId) => windowId === owner.id && !owner.isDestroyed() && owner.isVisible(),
    sendTabOp: (windowId, request) => {
      if (windowId !== owner.id || owner.isDestroyed() || owner.webContents.isDestroyed()) return false;
      if (request.op === "new") requestId = request.requestId;
      owner.webContents.send("native-fixture-tab-op", request);
      return true;
    },
    sendControl: () => {},
  });
  await win.loadURL(`${origin}/host`);
  const opened = browserTabRegistry.requestTabOp(win.id, { op: "new", url: `${origin}/page`, actor, active: true });
  // Agent pages own an independent native compositor from their initial blank document.
  const view = new WebContentsView({ webPreferences: {
    partition: NATIVE_BROWSER_PARTITION, focusOnNavigation: false, backgroundThrottling: false,
    contextIsolation: true, sandbox: true, nodeIntegration: false,
  } });
  guest = view.webContents;
  const ownedGuest = guest;
  win.contentView.addChildView(view);
  view.setBounds({ x: 232, y: 72, width: 900, height: 720 });
  win.once("closed", () => { if (!ownedGuest.isDestroyed()) ownedGuest.close(); });
  guest.setZoomFactor(1);
  trackBrowserGuest(guest, win.id, { kind: "native-view" });
  for (const event of ["before-input-event", "before-mouse-event", "input-event"] as const) {
    EventEmitter.prototype.on.call(guest, event, (_event: unknown, input: unknown) => { recordNativeInput(event, input); });
  }
  await guest.loadURL("about:blank");
  const binding = browserTabRegistry.bindTab(win.id, { tabId: rendererTabId, webContentsId: guest.id, requestId, parked: false });
  if (!binding.ok) throw new Error(`Native fixture binding failed: ${binding.error}`);
  const outcome = await opened;
  if (!outcome.ok) throw new Error(`Native fixture opening failed: ${outcome.error}`);
  tabId = outcome.tabId;
  browserTabRegistry.setActiveSurface(win.id, { kind: "browser", tabId: rendererTabId });
  await actions.prepare({ tab: record(), signal: new AbortController().signal });
  const bootstrapLease = browserTabRegistry.acquireControl(record(), actor);
  try { await actions.navigate({ tab: record(), signal: record().actions.signal, leaseId: bootstrapLease.id }, `${origin}/page`, browserOrigin(`${origin}/page`)!); }
  finally { browserTabRegistry.releaseControl(tabId, bootstrapLease.id); }
  guest.setZoomFactor(1);
  win.webContents.setZoomFactor(1);
  // Loading alone does not establish a rendered viewport. Let guest animation
  // frames advance at the final geometry before its first pointer gesture.
  await guest.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
    width: innerWidth, height: innerHeight, visibility: document.visibilityState
  }))))`).then((viewport: { width: number; height: number; visibility: string }) => {
    if (viewport.width !== 900 || viewport.height !== 720 || viewport.visibility !== "visible") {
      throw new Error(`Native fixture presentation unavailable: ${JSON.stringify(viewport)}`);
    }
  });
  if (fixtureMode === "foreground") { win.show(); app.focus({ steal: true }); win.focus(); }

}

void app.whenReady().then(async () => {
  await fs.mkdir(runtimeDir, { recursive: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native fixture server did not start");
  origin = `http://127.0.0.1:${address.port}`;
  await reset();
  const fixture: NativeBrowserFixture = { ready: true, get targetId() { return guest.id; }, get pendingWindowStartup() { return pendingWindowStartup; }, run, reset, assertClean: async () => assertNativeBrowserState(win, guest, rendererTabId), read: () => read(), close: async () => {
    const destroyed = guest.isDestroyed() ? undefined : once(guest, "destroyed");
    guest.stop(); await disposeBrowserUploads(); win.destroy(); await destroyed;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
  (globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture = fixture;
  process.stdout.write("NATIVE_BROWSER_FIXTURE_READY\n");

}).catch((error) => { console.error(error); app.exit(1); });
