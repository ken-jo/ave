import { writeFileSync } from "node:fs";
import { test, expect } from "../ui/fixtures.js";
import { setWindowSize } from "../ui/seeded-electron.js";

test.use({ seedViewFixturePlugin: false });

test("content resize settles in the renderer and diagnoses native clamping", async ({ app, mainWindow }, testInfo) => {
  const windowHandle = await app.browserWindow(mainWindow);
  const workArea = await app.evaluate(({ BrowserWindow, screen }) => {
    const target = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && window.isVisible())
      .sort((a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1])[0]!;
    return screen.getDisplayMatching(target.getBounds()).workArea;
  });
  await setWindowSize(app, 900, 720);
  const content = await windowHandle.evaluate((window) => window.getContentSize());
  const client = await mainWindow.evaluate(() => [document.documentElement.clientWidth, document.documentElement.clientHeight]);
  expect(client).toEqual(content);
  expect(client).toEqual([900, 720]);
  const position = await windowHandle.evaluate((window) => window.getPosition());
  expect(position).toEqual([workArea.x, workArea.y]);
  await expect(setWindowSize(app, 390, 240)).rejects.toThrow(/Requested content 390x240 is below window minimum/);
  // Some window managers allow oversized native windows; others clamp them. Never pre-reject based on display dimensions.
  const requested = [workArea.width + 100, workArea.height + 100];
  let resizeError: unknown;
  try {
    await setWindowSize(app, requested[0], requested[1]);
  } catch (error) {
    resizeError = error;
  }
  const oversized: number[] = await windowHandle.evaluate((window) => window.getContentSize());
  if (resizeError) {
    expect(String(resizeError)).toContain("Display work area clamped requested window content");
    expect(String(resizeError)).toContain(`requested ${requested[0]}x${requested[1]}`);
    expect(String(resizeError)).toContain(`actual content ${oversized.join("x")}`);
    expect(oversized.some((size, index) => Math.abs(size - requested[index]) > 1)).toBe(true);
  } else {
    expect(oversized.every((size, index) => Math.abs(size - requested[index]) <= 1)).toBe(true);
    const oversizedClient = await mainWindow.evaluate(() => [innerWidth, innerHeight]);
    expect(oversizedClient).toEqual(oversized);
  }
  const oversizedDocument = await mainWindow.evaluate(() => [document.documentElement.clientWidth, document.documentElement.clientHeight]);
  expect(oversizedDocument).toEqual(oversized);
  writeFileSync(testInfo.outputPath("clamp-diagnostics.json"), JSON.stringify({ workArea, requested, content: oversized, document: oversizedDocument, error: resizeError ? String(resizeError) : null }, null, 2));
  await mainWindow.screenshot({ path: testInfo.outputPath("native-clamp.png") });
  await setWindowSize(app, 900, 720);
  await expect(setWindowSize(app, 0, 720)).rejects.toThrow(/Invalid window content size/);
});
