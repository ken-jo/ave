import type { BrowserWindow } from "electron";
import type { ElectronApplication, Page } from "playwright";

/** Run a native action on the window owning the tested page, including inactive windows. */
export async function withPageWindow<Arg = undefined, Result = unknown>(
  app: ElectronApplication,
  page: Page,
  action: (window: BrowserWindow, arg: Arg) => Result | Promise<Result>,
  arg?: Arg,
): Promise<Result> {
  const target = await app.browserWindow(page);
  try {
    await target.evaluate((window) => {
      if (window.isDestroyed()) throw new Error("Test page window is unavailable");
    });
    // Callers pass serialized values; native handles are resolved only from the tested page.
    return await target.evaluate(action as Parameters<typeof target.evaluate<Result, Arg, BrowserWindow>>[0], arg as Arg);
  } finally {
    await target.dispose();
  }
}

/** Deliver to the native window owning the tested page, including inactive background windows. */
export async function sendRendererEvent(
  app: ElectronApplication,
  page: Page,
  channel: string,
  payload: unknown,
): Promise<void> {
  await withPageWindow(app, page, (window, event) => {
    window.webContents.send(event.channel, event.payload);
  }, { channel, payload });
}
