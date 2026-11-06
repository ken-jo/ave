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
  const frame = await windowHandle.evaluate((window) => {
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    return [bounds.width - content.width, bounds.height - content.height];
  });
  let resizeError: unknown;
  try {
    await setWindowSize(app, requested[0], requested[1]);
  } catch (error) {
    resizeError = error;
  }
  const oversized: number[] = await windowHandle.evaluate((window) => window.getContentSize());
  if (resizeError) {
    expect(String(resizeError)).toContain("native mismatch");
    expect(String(resizeError)).toContain("renderer mismatch");
    const limitedRequest = [Math.min(requested[0], workArea.width - frame[0]), Math.min(requested[1], workArea.height - frame[1])];
    const matchesWorkArea = oversized.every((size, index) => Math.abs(size - limitedRequest[index]) <= 1);
    expect(String(resizeError).includes("clamped by work area")).toBe(matchesWorkArea);
    expect((resizeError as Error).cause).toBeDefined();
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

test("native size limits do not imply work-area clamping", async ({ app, mainWindow }) => {
  const windowHandle = await app.browserWindow(mainWindow);
  const originalMaximum = await windowHandle.evaluate((window) => window.getMaximumSize());
  try {
    await windowHandle.evaluate((window) => window.setMaximumSize(800, 700));
    const failure: unknown = await setWindowSize(app, 900, 720).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("native mismatch");
    expect((failure as Error).message).toContain("requested 900x720");
    expect((failure as Error).message).not.toContain("clamped by work area");
    expect((failure as Error).cause).toBeDefined();
  } finally {
    await windowHandle.evaluate((window, size) => window.setMaximumSize(size[0], size[1]), originalMaximum);
  }
});

test("renderer mismatch is distinct from native mismatch", async ({ app, mainWindow }) => {
  await setWindowSize(app, 900, 720);
  const windowHandle = await app.browserWindow(mainWindow);
  try {
    await windowHandle.evaluate((window) => window.webContents.setZoomFactor(1.25));
    const failure: unknown = await setWindowSize(app, 900, 720).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("renderer mismatch");
    expect((failure as Error).message).not.toContain("native mismatch");
    expect((failure as Error).message).not.toContain("clamped by work area");
    expect((failure as Error).message).toContain("actual content 900x720");
    expect((failure as Error).cause).toBeDefined();
  } finally {
    await windowHandle.evaluate((window) => window.webContents.setZoomFactor(1));
  }
});
