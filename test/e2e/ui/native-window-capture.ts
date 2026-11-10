import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestInfo } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { browserHostIdentity } from "./browser-native-target.js";
import { REPO_ROOT } from "./seeded-electron.js";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
let captureExecutable: Promise<string> | undefined;

export async function prepareNativeWindowCapture(testInfo: TestInfo): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Native window capture requires the window screenshot service");
  if (!captureExecutable) {
    captureExecutable = (async () => {
      const output = await fs.realpath(testInfo.project.outputDir);
      const inside = relative(await fs.realpath(REPO_ROOT), output);
      assert(!isAbsolute(inside) && inside !== ".." && !inside.startsWith("../"), "Native capture output must stay inside the checkout");
      const build = await fs.mkdtemp(join(output, "native-window-capture-"));
      const target = join(build, "native-window-capture");
      const moduleCache = join(REPO_ROOT, ".cache", "native-window-capture-swift");
      await fs.mkdir(moduleCache, { recursive: true });
      await run("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-module-cache-path", moduleCache, join(HERE, "native-window-capture.swift"), "-o", target]);
      const permission = JSON.parse((await run(target, ["--preflight"])).stdout);
      assert.equal(permission.screenCaptureAccess, true, "Native capture requires existing permission; no permission request is made");
      return target;
    })();
  }
  return captureExecutable;
}

export async function captureNativeWindow(app: ElectronApplication, page: Page, testInfo: TestInfo, name: string) {
  const helper = await prepareNativeWindowCapture(testInfo);
  const sourceRevision = (await run("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"])).stdout.trim();
  assert.match(sourceRevision, /^[0-9a-f]{40}$/);
  const identity = await browserHostIdentity(app, page);
  const inspect = () => app.evaluate(({ BaseWindow, webContents }, identity) => {
    const owner = BaseWindow.fromId(identity.windowId);
    const chrome = webContents.fromId(identity.chromeId);
    if (!owner || owner.isDestroyed() || !chrome || chrome.isDestroyed()) throw new Error("Native capture owner is unavailable");
    return {
      ...identity, mediaSourceId: owner.getMediaSourceId(), ownerPid: process.pid,
      bounds: owner.getBounds(), content: owner.getContentBounds(), zoom: chrome.getZoomFactor(),
      focused: owner.isFocused(), focusedContentsId: webContents.getFocusedWebContents()?.id ?? null,
    };
  }, identity);
  const before = await inspect();
  const ui = await page.evaluate(() => ({
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    activeElement: document.activeElement ? {
      tag: document.activeElement.tagName, id: document.activeElement.id,
      testId: document.activeElement.getAttribute("data-testid"), role: document.activeElement.getAttribute("role"),
    } : null,
    nativePageHoles: Array.from(document.querySelectorAll("[data-ave-native-page]")).map(element => ({
      tabId: element.getAttribute("data-tab-id"), surface: element.getAttribute("data-ave-native-page"),
      bounds: element.getBoundingClientRect().toJSON(), visibility: getComputedStyle(element).visibility,
    })),
  }));
  assert.equal(before.focused, false, "Background capture must not focus its owner");
  const windowId = /^window:(\d+):/.exec(before.mediaSourceId)?.[1];
  assert(windowId, "Native capture requires an exact native window id");
  assert.equal(before.ownerPid, app.process().pid);
  const path = testInfo.outputPath(`${name}.png`);
  const result = JSON.parse((await run(helper, [windowId, String(before.ownerPid), String(before.bounds.width), String(before.bounds.height), path])).stdout);
  const after = await inspect();
  const statePath = testInfo.outputPath(`${name}-native-state.json`);
  await fs.writeFile(statePath, `${JSON.stringify({ sourceRevision, before, ui, result, after }, null, 2)}\n`);
  await testInfo.attach(`${name}-native-state`, { path: statePath, contentType: "application/json" });
  assert.equal(after.focused, false);
  assert.equal(after.focusedContentsId, before.focusedContentsId);
  assert.notEqual(result.frontmostBefore, before.ownerPid);
  assert.notEqual(result.frontmostAfter, before.ownerPid);
  assert.equal(result.targetActivatedDuringCapture, false);
  assert.equal(result.windowId, Number(windowId));
  assert.equal(result.ownerPid, before.ownerPid);
  assert.equal(result.width, before.bounds.width);
  assert.equal(result.height, before.bounds.height);
  await testInfo.attach(name, { path, contentType: "image/png" });
  return { path, before, result, after };
}

export async function sampleNativeWindow(app: ElectronApplication, capture: Awaited<ReturnType<typeof captureNativeWindow>>, points: readonly { x: number; y: number }[]) {
  const png = (await fs.readFile(capture.path)).toString("base64");
  return app.evaluate(({ nativeImage }, input) => {
    const image = nativeImage.createFromBuffer(Buffer.from(input.png, "base64"));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    return input.points.map(point => {
      const x = Math.floor(input.content.x - input.bounds.x + point.x * input.zoom);
      const y = Math.floor(input.content.y - input.bounds.y + point.y * input.zoom);
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) throw new Error("Native sample lies outside the target window");
      const offset = (y * size.width + x) * 4;
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]];
    });
  }, { png, points, ...capture.before });
}
