import type { ElectronApplication, Page } from "playwright";

export async function browserHostIdentity(app: ElectronApplication, page: Page): Promise<{ windowId: number; chromeId: number }> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return await app.evaluate(({ BaseWindow, webContents }, targetId) => {
      const chrome = webContents.fromDevToolsTargetId(targetId);
      if (!chrome || chrome.isDestroyed()) throw new Error("Native UI target is unavailable");
      type NativeView = { children: NativeView[]; webContents?: { id: number } };
      const contains = (view: NativeView): boolean => view.webContents?.id === chrome.id || view.children.some(contains);
      const owners = BaseWindow.getAllWindows().filter(owner => !owner.isDestroyed()
        && (Reflect.get(owner, "webContents") === chrome || contains(owner.contentView as NativeView)));
      const [owner] = owners;
      if (owners.length !== 1 || !owner) throw new Error("Native UI owner is unavailable or ambiguous");
      return { windowId: owner.id, chromeId: chrome.id };
    }, targetInfo.targetId);
  } finally {
    await session.detach();
  }
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
  return app.evaluate(({ BaseWindow, webContents }, target) => {
    const owner = BaseWindow.fromId(target.windowId);
    const matches = webContents.getAllWebContents().filter(contents => contents.getURL() === target.url);
    const [contents] = matches;
    if (!owner || matches.length !== 1 || !contents) throw new Error("Native browser target or owner is unavailable");
    const chrome = webContents.getAllWebContents().find(candidate => candidate === Reflect.get(owner, "webContents"));
    if (!chrome || chrome.isDestroyed()) throw new Error("Native UI contents are unavailable");
    type NativeView = { children: NativeView[]; webContents?: { id: number }; getBounds(): { x: number; y: number; width: number; height: number } };
    const contains = (view: NativeView): boolean => view.webContents?.id === contents.id || view.children.some(contains);
    const intersect = (a: ReturnType<NativeView["getBounds"]>, b: ReturnType<NativeView["getBounds"]>) => {
      const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
      return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
        height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
    };
    const presented = (view: NativeView, origin: { x: number; y: number }, clip: ReturnType<NativeView["getBounds"]>): boolean => {
      const bounds = view.getBounds();
      const position = { x: origin.x + bounds.x, y: origin.y + bounds.y };
      const visible = intersect(clip, { ...bounds, ...position });
      return visible.width > 0 && visible.height > 0 && (view.webContents?.id === contents.id || view.children.some(child => presented(child, position, visible)));
    };
    const { width, height } = owner.getContentBounds();
    return {
      id: contents.id,
      type: contents.getType(),
      embedded: Boolean(contents.hostWebContents),
      connected: contains(owner.contentView as NativeView),
      // A parked page retains a native root but occupies no part of the displayed window.
      attached: owner.contentView.children.some(child => presented(child as NativeView, { x: 0, y: 0 }, { x: 0, y: 0, width, height })),
      focused: contents.isFocused(),
      mainFrameFocused: contents.focusedFrame === contents.mainFrame,
      ownerFocused: owner.isFocused(),
      focusedContentsId: webContents.getFocusedWebContents()?.id ?? null,
      hostFrame: chrome.mainFrame.frameTreeNodeId,
      focusedHostFrame: chrome.focusedFrame?.frameTreeNodeId ?? null,
    };
  }, { windowId, url });
}
