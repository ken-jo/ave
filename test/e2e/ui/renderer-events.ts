import type { ElectronApplication, Page } from "playwright";

/** Deliver to the native window owning the tested page, including inactive background windows. */
export async function sendRendererEvent(
  app: ElectronApplication,
  page: Page,
  channel: string,
  payload: unknown,
): Promise<void> {
  const target = await app.browserWindow(page);
  try {
    await target.evaluate((window, event) => {
      if (window.isDestroyed()) throw new Error("Test page window is unavailable");
      window.webContents.send(event.channel, event.payload);
    }, { channel, payload });
  } finally {
    await target.dispose();
  }
}
