import { configureMainWindowWebviewAttach } from "./webview-attach.js";
import { createLogger } from "../lib/logger.js";
import { preloadPreferences } from "./preload-bundles.js";
import { BaseWindow, WebContentsView, type BaseWindowConstructorOptions, type View, type WebContents, type WebPreferences } from "electron";

export type MainWindow = BaseWindow & {
  readonly webContents: WebContents;
  loadURL: WebContents["loadURL"];
  loadFile: WebContents["loadFile"];
};

const log = createLogger("main-window-host");
const uiViews = new WeakMap<BaseWindow, WebContentsView>();

/** Creates the app document above the independent pages it presents. */
export function createMainWindowHost(options: BaseWindowConstructorOptions, preferences: Pick<WebPreferences, "zoomFactor">): MainWindow {
  const window = new BaseWindow(options);
  const ui = new WebContentsView({ webPreferences: {
    zoomFactor: preferences.zoomFactor,
    contextIsolation: true,
    nodeIntegration: false,
    ...preloadPreferences("preload"),
    webviewTag: true,
  } });
  const contents = ui.webContents;
  ui.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const attach = configureMainWindowWebviewAttach({
      event,
      webPreferences: webPreferences as Record<string, unknown>,
      params: params as unknown as Record<string, string>,
    });
    if (attach.result === "blocked" || attach.result === "refused") {
      log.warn({ src: params.src, partition: params.partition, owner: attach.owner }, "blocked webview attach");
    }
  });
  ui.setBackgroundColor("#00000000");
  installUiMembers(window, contents);
  uiViews.set(window, ui);
  window.contentView.addChildView(ui);
  const resize = (): void => {
    const { width, height } = window.getContentBounds();
    ui.setBounds({ x: 0, y: 0, width, height });
  };
  resize();
  window.on("resize", resize);
  window.on("closed", () => {
    uiViews.delete(window);
    if (!contents.isDestroyed()) contents.close();
  });
  contents.once("destroyed", () => {
    if (!window.isDestroyed()) window.destroy();
  });
  return window;
}

function installUiMembers(window: BaseWindow, contents: WebContents): asserts window is MainWindow {
  for (const name of ["webContents", "loadURL", "loadFile"]) {
    if (name in window) throw new Error("Main window UI member already exists");
  }
  Object.defineProperties(window, {
    webContents: { get: () => contents },
    loadURL: { value: contents.loadURL.bind(contents) },
    loadFile: { value: contents.loadFile.bind(contents) },
  });
}

export function attachMainWindowPage(owner: MainWindow, view: View): void {
  const ui = uiViews.get(owner);
  if (!ui || owner.isDestroyed()) throw new Error("Main window UI view unavailable");
  owner.contentView.addChildView(view);
  owner.contentView.addChildView(ui);
}

export function mainWindowFromNativeWindow(window: BaseWindow | null): MainWindow | null {
  if (!window || window.isDestroyed() || !uiViews.has(window)) return null;
  return window as MainWindow;
}

/** Native close waits for the app document's beforeunload decision. */
export function closeMainWindowUi(window: MainWindow): void {
  if (!uiViews.has(window)) throw new Error("Main window UI view unavailable");
  if (!window.webContents.isDestroyed()) window.webContents.close({ waitForBeforeUnload: true });
}

/** Flush document unload handlers within the application's existing shutdown deadline. */
export async function closeMainWindowDocuments(windows: readonly MainWindow[], signal: AbortSignal): Promise<void> {
  await Promise.all(windows.map((window) => new Promise<void>((resolve, reject) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) { resolve(); return; }
    const contents = window.webContents;
    const cleanup = (): void => {
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("will-prevent-unload", continueUnload);
      signal.removeEventListener("abort", aborted);
    };
    const destroyed = (): void => { cleanup(); resolve(); };
    const aborted = (): void => { cleanup(); reject(new Error("Main window document close aborted")); };
    // Application shutdown is already committed; run saves without allowing a renderer to strand cleanup.
    const continueUnload = (event: Electron.Event): void => event.preventDefault();
    if (signal.aborted) { aborted(); return; }
    contents.once("destroyed", destroyed);
    contents.on("will-prevent-unload", continueUnload);
    signal.addEventListener("abort", aborted, { once: true });
    try { closeMainWindowUi(window); }
    catch (error) { cleanup(); reject(error); }
  })));
}
