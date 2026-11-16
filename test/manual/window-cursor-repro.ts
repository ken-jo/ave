import { app, BaseWindow, BrowserWindow, WebContentsView } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { WebContents } from "electron";
import { configureE2eWindowPolicy } from "../../src/main/e2e-window-policy.js";
import { getCommonChromeOptions, getMainWindowGlassOptions } from "../../src/main/window-chrome.js";

export interface CursorCase {
  vibrancy: boolean;
  rootCss: boolean;
  edgeCover: boolean;
  host: "browser" | "child";
  nativeInset: number;
  nativeFrame?: boolean;
}

const config = JSON.parse(process.env.AVE_CURSOR_REPRO_CASE ?? "{}") as CursorCase;
const stylesPath = process.env.AVE_CURSOR_REPRO_STYLES;
const output = process.env.AVE_CURSOR_REPRO_OUTPUT;
const background = process.env.AVE_NATIVE_FIXTURE_MODE !== "foreground";
configureE2eWindowPolicy();

app.whenReady().then(async () => {
  const glass = getMainWindowGlassOptions("vibrancy");
  if (!config.vibrancy) delete glass.vibrancy;
  const options = {
    ...getCommonChromeOptions(), ...glass,
    width: 950, height: 734, show: false,
    title: `Window cursor: ${JSON.stringify(config)}`,
  };
  if (config.nativeFrame) {
    delete options.titleBarStyle;
    delete options.trafficLightPosition;
    options.frame = true;
  }
  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
  let window: BaseWindow;
  let contents: WebContents;
  if (config.host === "child") {
    window = new BaseWindow(options);
    const view = new WebContentsView({ webPreferences: preferences });
    contents = view.webContents;
    view.setBackgroundColor("#00000000");
    window.contentView.addChildView(view);
    const resize = () => {
      const { width, height } = window.getContentBounds();
      const inset = config.nativeInset;
      view.setBounds({ x: inset, y: inset, width: Math.max(1, width - inset * 2), height: Math.max(1, height - inset * 2) });
    };
    window.on("resize", resize);
    resize();
    window.on("closed", () => { if (!contents.isDestroyed()) contents.close(); });
  } else {
    const browser = new BrowserWindow({ ...options, webPreferences: preferences });
    window = browser;
    contents = browser.webContents;
  }
  const styles = config.rootCss && stylesPath ? readFileSync(stylesPath, "utf8") : "";
  const root = config.rootCss ? `<div id="root"><div id="app-shell" class="relative grid h-screen min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[var(--shell-canvas-top)_minmax(0,1fr)] overflow-hidden">
    <div id="titlebar" class="relative h-(--chrome-band-height)" style="app-region:initial"><div id="drag-region" class="pointer-events-none absolute inset-x-(--chrome-gap-tight) top-(--chrome-gap-tight) bottom-0" style="app-region:drag"></div></div><main></main></div></div>` : "";
  const cover = config.edgeCover ? '<div id="edge-cover" style="position:fixed;inset:0;pointer-events:auto;cursor:auto;app-region:initial"></div>' : "";
  const html = `<!doctype html><html${config.rootCss ? ' data-glass="on"' : ""}><head><meta charset="utf-8"><style>${styles}</style></head><body${config.rootCss ? ' class="ave-glass-clear min-h-screen bg-background text-foreground antialiased"' : ""}>${root}${cover}</body></html>`;
  // File URLs keep the stylesheet's relative assets in their original directory.
  await contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { baseURLForDataURL: stylesPath ? pathToFileURL(stylesPath).href : undefined });
  if (background) window.showInactive();
  else window.show();
  const renderer = await contents.executeJavaScript(`(() => {
    const describe = element => { const style = getComputedStyle(element); return { tag: element.tagName, id: element.id,
      cursor: style.cursor, appRegion: style.getPropertyValue('-webkit-app-region'), overflow: style.overflow,
      pointerEvents: style.pointerEvents, bounds: element.getBoundingClientRect().toJSON() }; };
    return { size: [innerWidth, innerHeight], html: describe(document.documentElement), body: describe(document.body),
      edges: [[1,innerHeight/2],[innerWidth-1,innerHeight/2],[innerWidth/2,innerHeight-1],[1,1],[innerWidth-1,1],
        [1,innerHeight-1],[innerWidth-1,innerHeight-1]].map(([x,y]) => ({ x,y, stack: document.elementsFromPoint(x,y).map(describe) })) };
  })()`);
  const snapshot = { config, options, versions: process.versions, platform: process.platform,
    native: { bounds: window.getBounds(), content: window.getContentBounds(), resizable: window.isResizable(), focused: window.isFocused(),
      children: window.contentView.children.map(view => view.getBounds()) }, renderer,
    nativeHover: "not-measured" };
  if (output) writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ config, runtime: process.versions.electron, engine: process.versions.chrome, native: snapshot.native, nativeHover: snapshot.nativeHover }));
}).catch(error => { console.error(error); app.exit(1); });

app.on("window-all-closed", () => app.quit());
