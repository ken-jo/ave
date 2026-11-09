import type { ElectronApplication, Page } from "playwright";

export async function browserHostIdentity(app: ElectronApplication, page: Page): Promise<{ windowId: number; chromeId: number }> {
  const owner = await app.browserWindow(page);
  return owner.evaluate(window => ({ windowId: window.id, chromeId: window.webContents.id }));
}

export async function browserTargetId(app: ElectronApplication, url: string): Promise<number> {
  return app.evaluate(({ webContents }, targetUrl) => {
    const targets = webContents.getAllWebContents().filter(contents => contents.getURL() === targetUrl);
    const [target] = targets;
    if (targets.length !== 1 || !target) throw new Error(`Expected one native browser target, found ${targets.length}`);
    return target.id;
  }, url);
}

export async function inspectBrowserTarget(app: ElectronApplication, windowId: number, url: string) {
  return app.evaluate(({ BrowserWindow, webContents }, target) => {
    const owner = BrowserWindow.fromId(target.windowId);
    const matches = webContents.getAllWebContents().filter(contents => contents.getURL() === target.url);
    const [contents] = matches;
    if (!owner || matches.length !== 1 || !contents) throw new Error("Native browser target or owner is unavailable");
    type NativeView = { children: NativeView[]; webContents?: { id: number } };
    const contains = (view: NativeView): boolean => view.webContents?.id === contents.id || view.children.some(contains);
    return {
      id: contents.id,
      type: contents.getType(),
      embedded: Boolean(contents.hostWebContents),
      attached: contains(owner.contentView as NativeView),
      focused: contents.isFocused(),
      mainFrameFocused: contents.focusedFrame === contents.mainFrame,
      ownerFocused: owner.isFocused(),
      focusedContentsId: webContents.getFocusedWebContents()?.id ?? null,
      hostFrame: owner.webContents.mainFrame.frameTreeNodeId,
      focusedHostFrame: owner.webContents.focusedFrame?.frameTreeNodeId ?? null,
    };
  }, { windowId, url });
}
