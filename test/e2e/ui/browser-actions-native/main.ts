import { app, BrowserWindow, nativeImage, type WebContents } from "electron";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createBrowserPageActions } from "../../../../src/main/browser/browser-actions.js";
import { browserTabRegistry } from "../../../../src/main/browser/browser-tab-registry.js";
import { trackBrowserGuest } from "../../../../src/main/browser/browser-guest-tracking.js";
import { disposeBrowserUploads } from "../../../../src/main/browser/browser-upload.js";
import { browserOrigin } from "../../../../src/shared/browser-tools.js";
import type { BrowserActionTab } from "../../../../src/tools/browser-tools.js";
import type { NativeAction, NativeActionResult, NativeBrowserFixture, NativeOracle } from "./contract.js";

const fixtureDir = process.env.AVE_NATIVE_FIXTURE_DIR;
const runtimeDir = process.env.AVE_NATIVE_FIXTURE_RUNTIME;
const preload = process.env.AVE_NATIVE_FIXTURE_PRELOAD;
if (!fixtureDir || !runtimeDir || !preload) throw new Error("Native fixture paths are required");
if (process.platform === "darwin") app.setActivationPolicy("regular");
const actor = { sessionId: "native-fixture-conversation" };
const rendererTabId = "native-fixture-browser";
const originalBytes = "immutable fixture bytes\n";
let received: { bytes: string; name: string } | null = null;
let guest: WebContents;
let tabId = "";
let win: BrowserWindow;
let requestId = "";
const nativeEvents: { event: string; type: string; modifiers: number; raw: Record<string, unknown> }[] = [];
const server = createServer(async (request, response) => {
  if (request.url === "/host") {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><title>Native action host</title><style>body{margin:0;background:#e8edf2;font:16px sans-serif}aside{width:210px;padding:18px}webview{position:absolute;left:230px;top:70px;width:900px;height:720px;border:2px solid #345}</style><aside>Trusted fixture chrome<input id="composer" aria-label="Host composer" autofocus></aside><webview src="about:blank" partition="native-browser-actions-fixture" webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"></webview><script>window.nativeFixtureChrome.onTabOp(request => { const view = document.querySelector("webview"); if (request.op === "focus" && request.tabId === "native-fixture-browser" && view.isConnected && document.visibilityState === "visible" && view.getBoundingClientRect().width > 0) view.focus(); if (request.op === "restore-focus") document.getElementById("composer").focus(); });</script>');
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
});

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

void app.whenReady().then(async () => {
if (process.platform === "darwin") await app.dock.show();
await fs.mkdir(runtimeDir, { recursive: true });
await fs.writeFile(join(runtimeDir, "selected.txt"), originalBytes);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Native fixture server did not start");
const origin = `http://127.0.0.1:${address.port}`;
win = new BrowserWindow({ width: 1180, height: 900, x: 40, y: 40, show: true,
  webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true, preload } });
win.webContents.on("will-attach-webview", (_event, preferences) => {
  preferences.contextIsolation = true; preferences.sandbox = true; preferences.nodeIntegration = false; delete preferences.preload;
});
browserTabRegistry.setRendererLink({
  isWindowVisible: (windowId) => windowId === win.id && !win.isDestroyed() && win.isVisible(),
  sendTabOp: (_windowId, request) => {
    if (request.op === "new") requestId = request.requestId;
    win.webContents.send("native-fixture-tab-op", request);
    return true;
  },
  sendControl: () => {},
});
let attach!: () => void;
const attached = new Promise<void>((resolve) => { attach = resolve; });
win.webContents.once("did-attach-webview", (_event, contents) => {
  guest = contents;
  trackBrowserGuest(guest, win.id);
  for (const event of ["before-input-event", "before-mouse-event", "input-event"] as const) {
    guest.on(event, (_event, input) => { const fields = input as unknown as { type: string; _modifiers?: number }; const raw = Object.fromEntries(Object.getOwnPropertyNames(input).map((key) => [key, (input as unknown as Record<string, unknown>)[key]]).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value))); nativeEvents.push({ event, type: fields.type, modifiers: fields._modifiers ?? 0, raw }); });
  }
  const bind = () => {
    const result = browserTabRegistry.bindTab(win.id, { tabId: rendererTabId, webContentsId: guest.id, requestId });
    if (!result.ok) throw new Error(`Native fixture binding failed: ${result.error}`);
    attach();
  };
  if (guest.getURL() === "about:blank" && !guest.isLoading()) bind(); else guest.once("did-finish-load", bind);
});
const opened = browserTabRegistry.requestTabOp(win.id, { op: "new", url: `${origin}/page`, actor, active: true });
await win.loadURL(`${origin}/host`);
await attached;
const outcome = await opened;
if (!outcome.ok) throw new Error(`Native fixture opening failed: ${outcome.error}`);
tabId = outcome.tabId;
browserTabRegistry.setActiveSurface(win.id, { kind: "browser", tabId: rendererTabId });
await actions.prepare({ tab: record(), signal: new AbortController().signal });
const bootstrapLease = browserTabRegistry.acquireControl(record(), actor);
try { await actions.navigate({ tab: record(), signal: record().actions.signal, leaseId: bootstrapLease.id }, `${origin}/page`, browserOrigin(`${origin}/page`)!); }
finally { browserTabRegistry.releaseControl(tabId, bootstrapLease.id); }
win.show(); app.focus({ steal: true }); win.focus();

const fixture: NativeBrowserFixture = { ready: true, run, read: () => read(), close: async () => {
  guest.stop(); await disposeBrowserUploads(); win.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
} };
(globalThis as unknown as { nativeBrowserFixture: NativeBrowserFixture }).nativeBrowserFixture = fixture;
process.stdout.write("NATIVE_BROWSER_FIXTURE_READY\n");

}).catch((error) => { console.error(error); app.exit(1); });
