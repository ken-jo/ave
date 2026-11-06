import { test, expect } from "../ui/fixtures.js";
import { setWindowSize } from "../ui/seeded-electron.js";

test.use({ seedViewFixturePlugin: false });

test("content resize settles in the renderer and rejects unattainable sizes", async ({ app, mainWindow }) => {
  await setWindowSize(app, 900, 720);
  const content = await app.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && window.isVisible())
      .sort((a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1])[0]!;
    return target.getContentSize();
  });
  const client = await mainWindow.evaluate(() => [document.documentElement.clientWidth, document.documentElement.clientHeight]);
  expect(client).toEqual(content);
  expect(client).toEqual([900, 720]);
  await expect(setWindowSize(app, 390, 240)).rejects.toThrow(/Requested content 390x240 is below window minimum/);
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
  await expect(setWindowSize(app, workArea.width + 100, workArea.height + 100)).rejects.toThrow(/exceeds display work area/);
  await expect(setWindowSize(app, 0, 720)).rejects.toThrow(/Invalid window content size/);
});
