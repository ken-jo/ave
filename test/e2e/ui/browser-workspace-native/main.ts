import { app, BrowserWindow, nativeImage, type WebContents, type WebPreferences } from "electron";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { registerMainWindow, unregisterMainWindow } from "../../../../src/main/app-state.js";
import { browserTabRegistry } from "../../../../src/main/browser/browser-tab-registry.js";
import { trackBrowserGuest } from "../../../../src/main/browser/browser-guest-tracking.js";
import { disposeBrowserWorkspaceService, getBrowserWorkspaceService, refreshBrowserPopupControl } from "../../../../src/main/browser/browser-workspace-desktop.js";
import { attachSideBrowserWebview, configureSideBrowserWebviewAttach, installSideBrowserPartitionPolicy } from "../../../../src/main/side-browser-webview.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../../src/shared/side-browser.js";
import type { BrowserPreview } from "../../../../src/shared/browser-workspace.js";

const runtime = process.env.AVE_WORKSPACE_FIXTURE_RUNTIME;
if (!runtime || !process.env.AVE_HOME) throw new Error("Isolated workspace fixture paths are required");
app.setPath("userData", join(runtime, "profile"));
const rendererTabId = "workspace-native-page";
const actor = { sessionId: "workspace-native-conversation" };
let owner: BrowserWindow;
let guest: WebContents;
let mainHandle = "";
let requestId = "";
const nativeEvents: Record<string, unknown>[] = [];

export interface WorkspaceNativeState {
  readonly mainHandle: string;
  readonly ownerWindowId: number;
  readonly mainVisible: boolean;
  readonly nativeEvents: readonly Record<string, unknown>[];
  readonly popup: null | {
    readonly handle: string; readonly kind: string; readonly openerTabId: string | null; readonly windowId: number;
    readonly mode: string; readonly generation: number; readonly title: string; readonly nativeTitle: string;
    readonly nativeWindowId: number; readonly windowFocused: boolean; readonly guestFocused: boolean;
    readonly sameSession: boolean; readonly sandbox: boolean; readonly contextIsolation: boolean; readonly nodeIntegration: boolean;
  };
}
export interface WorkspaceNativeFixture {
  readonly ready: true;
  read(): WorkspaceNativeState;
  openPopup(): Promise<void>;
  selectPopup(): Promise<unknown>;
  holdPopup(): WorkspaceNativeState;
  resumePopup(): boolean;
  find(forward: boolean, findNext: boolean): Promise<{ matches: number; activeMatchOrdinal: number }>;
  preview(): Promise<{ preview: BrowserPreview; bytes: number; decodedWidth: number; decodedHeight: number; focusPreserved: boolean }>;
  hiddenPreviewRace(): Promise<{ secondError: string; firstError: string; hiddenError: string; hidden: boolean }>;
  close(): Promise<void>;
}

const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/host") {
    response.end(`<!doctype html><meta charset="utf-8"><title>Browser workspace fixture</title>
      <style>body{margin:0;background:#e9eef2;font:16px sans-serif}header{padding:20px}webview{position:absolute;left:70px;top:70px;width:760px;height:530px;border:2px solid #315}</style>
      <header>Trusted workspace fixture</header><webview src="about:blank" partition="${AVE_SIDE_BROWSER_PARTITION}"></webview>`);
  } else if (request.url === "/popup") {
    response.end('<!doctype html><meta charset="utf-8"><title>Workspace popup</title><style>body{font:22px sans-serif;background:#e2f6eb;padding:28px}button{padding:24px}</style><h1>Native popup</h1><button id="human">Human action</button>');
  } else {
    response.end('<!doctype html><meta charset="utf-8"><title>Workspace page</title><style>body{font:24px sans-serif;background:#e6f0ff;padding:30px}p{margin:30px 0}a{display:block;padding:20px;background:#d7e8cc}section{height:150px;background:linear-gradient(90deg,#3f76ab,#da7b52)}</style><a id="popup" href="/popup" target="_blank">Open native popup</a><p>workspace-needle</p><section>Actual native capture scene</section><p>workspace-needle</p>');
  }
});

function popupRecord() {
  const view = browserTabRegistry.controlState(owner.id).tabs.find((tab) => tab.kind === "popup");
  const record = view && browserTabRegistry.liveTabInWindow(view.tabId, owner.id);
  if (!record?.guest) throw new Error("Native popup is not registered");
  return record;
}

function nativeWebPreferences(contents: WebContents): Readonly<WebPreferences> {
  const native = contents as WebContents & { getLastWebPreferences?(): Readonly<WebPreferences> };
  if (typeof native.getLastWebPreferences !== "function") throw new Error("Native popup preferences are unavailable");
  return native.getLastWebPreferences();
}

function read(): WorkspaceNativeState {
  const view = browserTabRegistry.controlState(owner.id).tabs.find((tab) => tab.kind === "popup");
  const record = view && browserTabRegistry.liveTabInWindow(view.tabId, owner.id);
  const window = record?.guest && BrowserWindow.fromWebContents(record.guest);
  const preferences = record?.guest && nativeWebPreferences(record.guest);
  return {
    mainHandle, ownerWindowId: owner.id, mainVisible: owner.isVisible(), nativeEvents: nativeEvents.slice(-20),
    popup: record?.guest && window ? {
      handle: record.handle, kind: record.targetKind, openerTabId: record.openerTabId, windowId: record.windowId,
      mode: record.controlMode, generation: record.controlGeneration, title: record.guest.getTitle(), nativeTitle: window.getTitle(),
      nativeWindowId: window.id, windowFocused: window.isFocused(), guestFocused: record.guest.isFocused(),
      sameSession: record.guest.session === guest.session, sandbox: preferences?.sandbox === true,
      contextIsolation: preferences?.contextIsolation === true, nodeIntegration: preferences?.nodeIntegration === true,
    } : null,
  };
}

function target() {
  const record = browserTabRegistry.liveRendererTab(owner.id, rendererTabId);
  if (!record?.guest) throw new Error("Workspace page is not registered");
  return { tabId: rendererTabId, documentGeneration: record.documentId };
}

async function find(forward: boolean, findNext: boolean): Promise<{ matches: number; activeMatchOrdinal: number }> {
  return new Promise((resolve, reject) => {
    let expectedRequest = -1;
    const cleanup = () => { clearTimeout(timer); guest.removeListener("found-in-page", found); };
    const found = (_event: unknown, result: { requestId: number; matches: number; activeMatchOrdinal: number; finalUpdate: boolean }) => {
      if (result.requestId !== expectedRequest || !result.finalUpdate) return;
      cleanup();
      resolve({ matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Native find receipt timed out")); }, 5_000);
    guest.on("found-in-page", found);
    try { expectedRequest = getBrowserWorkspaceService().find(owner.id, { ...target(), text: "workspace-needle", forward, findNext }).requestId; }
    catch (error) { cleanup(); reject(error); }
  });
}

async function preview() {
  const before = BrowserWindow.getFocusedWindow()?.id ?? null;
  const image = await getBrowserWorkspaceService().preview(owner.id, target());
  const decoded = nativeImage.createFromDataURL(image.dataUrl);
  const size = decoded.getSize();
  return {
    preview: image, bytes: Buffer.from(image.dataUrl.split(",")[1]!, "base64").byteLength,
    decodedWidth: size.width, decodedHeight: size.height,
    focusPreserved: before === (BrowserWindow.getFocusedWindow()?.id ?? null),
  };
}

function errorCode(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function hiddenPreviewRace() {
  const service = getBrowserWorkspaceService();
  // The first real native capture yields; the second request sees its owner
  // before any cached image exists, and hide invalidates that in-flight image.
  const first = service.preview(owner.id, target()).then(() => "unexpected-success", errorCode);
  const second = service.preview(owner.id, target()).then(() => "unexpected-success", errorCode);
  owner.hide();
  const secondError = await second;
  const firstError = await first;
  const hiddenError = await service.preview(owner.id, target()).then(() => "unexpected-success", errorCode);
  return { secondError, firstError, hiddenError, hidden: !owner.isVisible() };
}

void app.whenReady().then(async () => {
  await fs.mkdir(runtime, { recursive: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workspace fixture server did not start");
  const origin = `http://127.0.0.1:${address.port}`;
  installSideBrowserPartitionPolicy();
  owner = new BrowserWindow({ width: 940, height: 740, x: 40, y: 40, show: true,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  registerMainWindow(owner, "primary");
  const windowId = owner.id;
  owner.once("closed", () => { browserTabRegistry.releaseWindow(windowId); unregisterMainWindow(owner); });
  owner.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (configureSideBrowserWebviewAttach({ event, webPreferences: preferences as unknown as Record<string, unknown>, params }) !== "accepted") event.preventDefault();
  });
  let finishAttach!: () => void;
  const attached = new Promise<void>((resolve) => { finishAttach = resolve; });
  owner.webContents.once("did-attach-webview", (_event, contents) => {
    guest = contents;
    guest.prependListener("did-create-window", (child: BrowserWindow) => {
      nativeEvents.push({ type: "native-child-created", sameSession: child.webContents.session === guest.session });
    });
    guest.on("input-event", (_event, input) => { if (input.type === "mouseDown" || input.type === "mouseUp") nativeEvents.push({ ...input }); });
    attachSideBrowserWebview(guest, owner);
    trackBrowserGuest(guest, owner.id);
    const bind = () => {
      const result = browserTabRegistry.bindTab(owner.id, { tabId: rendererTabId, webContentsId: guest.id, requestId });
      if (!result.ok) throw new Error(`Workspace fixture bind failed: ${result.error}`);
      finishAttach();
    };
    if (guest.getURL() === "about:blank" && !guest.isLoading()) bind(); else guest.once("did-finish-load", bind);
  });
  browserTabRegistry.setRendererLink({
    sendTabOp: (_windowId, request) => { if (request.op !== "new") return false; requestId = request.requestId; return true; },
    sendControl: refreshBrowserPopupControl,
    isWindowVisible: (id) => id === owner.id && owner.isVisible() && !owner.isMinimized(),
  });
  const opened = browserTabRegistry.requestTabOp(owner.id, { op: "new", url: `${origin}/page`, actor, active: true });
  await owner.loadURL(`${origin}/host`);
  await attached;
  const outcome = await opened;
  if (!outcome.ok) throw new Error(`Workspace fixture open failed: ${outcome.error}`);
  mainHandle = outcome.tabId;
  await guest.loadURL(`${origin}/page`);
  browserTabRegistry.setActiveSurface(owner.id, { kind: "browser", tabId: rendererTabId });
  owner.show(); app.focus({ steal: true }); owner.focus();
  const fixture: WorkspaceNativeFixture = {
    ready: true, read, find, preview, hiddenPreviewRace,
    openPopup: () => guest.executeJavaScript('document.getElementById("popup").click()', true),
    selectPopup: () => browserTabRegistry.requestTabOp(owner.id, { op: "select", tabId: popupRecord().handle }),
    holdPopup: () => { browserTabRegistry.acquireControl(popupRecord(), actor); return read(); },
    resumePopup: () => browserTabRegistry.resumePopup(owner.id, popupRecord().handle),
    close: async () => {
      disposeBrowserWorkspaceService();
      if (!owner.isDestroyed()) owner.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  (globalThis as unknown as { workspaceNativeFixture: WorkspaceNativeFixture }).workspaceNativeFixture = fixture;
}).catch((error) => { console.error(error); app.exit(1); });
