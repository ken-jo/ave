import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type TestInfo } from "@playwright/test";
import type { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { captureNativeWindow, sampleNativeWindow } from "./native-window-capture.js";

export type UiLayerFixture = Awaited<ReturnType<typeof launchUiLayerFixture>>;
export interface OverlayBounds { x: number; y: number; width: number; height: number }
const PAGE_COLOR = [180, 0, 200, 255];

export const DENIAL_ID = "12345678-1234-1234-1234-123456789abc";

export async function seedDenialHistory(aveHome: string) {
  const directory = join(aveHome, "permissions");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(directory, "recently-denied.json"), `${JSON.stringify([{
    id: DENIAL_ID, ts: new Date().toISOString(), toolName: "routine_schedule", source: "builtin", category: "write",
    inputSummary: JSON.stringify({ execution: "llm-session", payload: "Retained native page dialog fixture" }),
    reason: "The request needs a new approval.",
  }])}\n`, { mode: 0o600 });
}

export function nativePageHole(fixture: UiLayerFixture) {
  return fixture.page.locator(`[data-ave-native-page][data-tab-id="${fixture.rendererTabId}"]`);
}

export async function settleOverlayLayout(fixture: UiLayerFixture) {
  await expect.poll(() => fixture.page.evaluate(() => document.getAnimations().every(
    animation => !(animation instanceof CSSTransition) || animation.playState !== "running",
  ))).toBe(true);
}

export async function openPagePoint(fixture: UiLayerFixture, excluded: readonly OverlayBounds[] = []) {
  const hole = nativePageHole(fixture);
  const box = await hole.boundingBox();
  assert(box, "Native page rectangle unavailable");
  const viewport = await fixture.app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error("Native body sample target unavailable");
    return contents.executeJavaScript("({width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight})");
  }, fixture.targetId);
  assert(viewport.width > 0 && viewport.height > 0 && viewport.clientWidth > 0 && viewport.clientHeight > 0, "Native body sample geometry unavailable");
  const bodyBounds = { x: box.x, y: box.y, width: box.width * viewport.clientWidth / viewport.width,
    height: box.height * viewport.clientHeight / viewport.height };
  const point = await fixture.page.evaluate(({ bounds, excluded }) => {
    const painted = [...document.querySelectorAll('[data-testid="agent-browser-pip-card"]')].flatMap(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" ? [rect] : [];
    });
    for (const y of [bounds.y + bounds.height - 30, bounds.y + bounds.height / 2]) {
      for (const x of [bounds.x + bounds.width / 2, bounds.x + 12, bounds.x + bounds.width - 12]) {
        if ([...excluded, ...painted].some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)) continue;
        if (document.elementFromPoint(x, y)?.closest("[data-ave-native-page]")) return { x, y };
      }
    }
    return null;
  }, { bounds: bodyBounds, excluded });
  assert(point, "Partial overlay must leave an interactive page hole");
  return { ...point, bodyBounds, nativeViewport: viewport };
}

/** A genuine native frame proves UI pixels and exposed native pixels coexist. */
export async function captureOverlay(fixture: UiLayerFixture, overlay: Locator, testInfo: TestInfo, name: string,
  options: { overlap: boolean; fullCover?: boolean; point?: { x: number; y: number } }) {
  await expect(overlay).toBeVisible();
  await settleOverlayLayout(fixture);
  const pageRect = await nativePageHole(fixture).boundingBox();
  const overlayRect = await overlay.boundingBox();
  assert(pageRect && overlayRect, "Overlay geometry unavailable");
  const intersection = {
    x: Math.max(pageRect.x, overlayRect.x), y: Math.max(pageRect.y, overlayRect.y),
    right: Math.min(pageRect.x + pageRect.width, overlayRect.x + overlayRect.width),
    bottom: Math.min(pageRect.y + pageRect.height, overlayRect.y + overlayRect.height),
  };
  const area = Math.max(0, intersection.right - intersection.x) * Math.max(0, intersection.bottom - intersection.y);
  const overlayPoint = options.point ?? (area > 0
    ? { x: (intersection.x + intersection.right) / 2, y: (intersection.y + intersection.bottom) / 2 }
    : { x: overlayRect.x + overlayRect.width / 2, y: overlayRect.y + overlayRect.height / 2 });
  const exposed = options.fullCover ? null : await openPagePoint(fixture, [overlayRect]);
  const capture = await captureNativeWindow(fixture.app, fixture.page, testInfo, name);
  const pixels = await sampleNativeWindow(fixture.app, capture, exposed ? [overlayPoint, exposed] : [overlayPoint]);
  const paint = await fixture.page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-browser-pip-card"], [data-testid="browser-observation-preview"], img[src^="data:image"]')].flatMap(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return [];
    const ancestors: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const id = node.getAttribute("data-testid");
      if (id) ancestors.push(id);
    }
    return [{ kind: element.getAttribute("data-testid") ?? element.tagName, tabId: element.getAttribute("data-tab-id"),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ancestors }];
  }));
  const geometry = { pageRect, overlayRect, intersection, area, overlayPoint, exposed, pixels, paint };
  const geometryPath = testInfo.outputPath(`${name}-geometry.json`);
  await fs.writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await testInfo.attach(`${name}-geometry`, { contentType: "application/json", path: geometryPath });
  if (options.overlap) expect(area).toBeGreaterThan(0);
  else expect(area).toBe(0);
  expect(pixels[0]).not.toEqual(PAGE_COLOR);
  if (exposed) expect(pixels[1]).toEqual(PAGE_COLOR);
  return { capture, geometry };
}

/** The uncovered page action must paint its own live pixels rather than an underlying host preview. */
export async function assertExposedActionPaint(fixture: UiLayerFixture, rendered: Awaited<ReturnType<typeof captureOverlay>>, testInfo: TestInfo, name: string) {
  const pips = rendered.geometry.paint.filter(element => element.kind === "agent-browser-pip-card" && element.tabId === fixture.rendererTabId);
  expect(pips, "The page already visible in its pane must not have its own PiP card").toHaveLength(0);
  const action = await fixture.app.evaluate(async ({ webContents }, id) => {
    const target = webContents.fromId(id);
    if (!target) throw new Error("Native action paint target unavailable");
    const action = await target.executeJavaScript(`(() => {
      const element=document.getElementById('action'), rect=element.getBoundingClientRect();
      const context=new OffscreenCanvas(1,1).getContext('2d');
      context.fillStyle=getComputedStyle(element).backgroundColor;context.fillRect(0,0,1,1);
      return {x:rect.x+8,y:rect.y+rect.height/2,computed:[...context.getImageData(0,0,1,1).data]};
    })()`);
    const zoom = target.getZoomFactor();
    const pixel = await target.capturePage({ x: Math.floor(action.x * zoom), y: Math.floor(action.y * zoom), width: 1, height: 1 });
    const bitmap = pixel.toBitmap();
    return { ...action, expected: [bitmap[2], bitmap[1], bitmap[0], bitmap[3]] };
  }, fixture.targetId);
  const point = { x: rendered.geometry.pageRect.x + action.x, y: rendered.geometry.pageRect.y + action.y };
  const rect = rendered.geometry.overlayRect;
  expect(point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height).toBe(false);
  const [actual] = await sampleNativeWindow(fixture.app, rendered.capture, [point]);
  const path = testInfo.outputPath(`${name}-page-action-paint.json`);
  await fs.writeFile(path, JSON.stringify({ point, computed: action.computed, expected: action.expected, actual, paint: rendered.geometry.paint }, null, 2));
  await testInfo.attach(`${name}-page-action-paint`, { path, contentType: "application/json" });
  expect(actual).toEqual(action.expected);
}

export async function scrollExposedPage(fixture: UiLayerFixture, excluded: readonly OverlayBounds[] = []) {
  const point = await openPagePoint(fixture, excluded);
  const before = await fixture.readPage();
  await fixture.page.mouse.move(point.x, point.y);
  await fixture.page.mouse.wheel(0, 240);
  await expect.poll(async () => (await fixture.readPage()).scrollY).toBeGreaterThan(before.scrollY);
  expect((await fixture.readPage()).wheels).toBeGreaterThan(before.wheels);
  await fixture.page.mouse.wheel(0, -240);
  await expect.poll(async () => (await fixture.readPage()).scrollY).toBe(before.scrollY);
}

export async function clickExposedAction(fixture: UiLayerFixture, excluded: readonly OverlayBounds[] = []) {
  const point = await exposedControlPoint(fixture, "action", excluded);
  const before = (await fixture.readPage()).clicks;
  await fixture.page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await fixture.readPage()).clicks).toBe(before + 1);
  expect(await fixture.readPage()).toMatchObject({ trusted: true, activation: true });
}

/** Background companion: actual hole press selects the editor; keys address that page explicitly. */
export async function typeExposedEditor(fixture: UiLayerFixture, text: string, excluded: readonly OverlayBounds[] = []) {
  const point = await exposedControlPoint(fixture, "editor", excluded);
  await fixture.page.mouse.click(point.x, point.y);
  const selected = await fixture.app.evaluate(async ({ webContents }, input) => {
    const target = webContents.fromId(input.id);
    if (!target) throw new Error("Native keyboard target unavailable");
    const selected = await target.executeJavaScript("(() => { const e=document.getElementById('editor'); return {value:e.value,start:e.selectionStart,end:e.selectionEnd,focused:document.activeElement===e}; })()");
    if (!selected.focused) throw new Error("Native editor did not receive the hole press");
    for (const key of input.text) {
      target.sendInputEvent({ type: "keyDown", keyCode: key });
      target.sendInputEvent({ type: "char", keyCode: key });
      target.sendInputEvent({ type: "keyUp", keyCode: key });
    }
    return selected;
  }, { id: fixture.targetId, text });
  await expect.poll(async () => (await fixture.readPage()).value).toBe(selected.value.slice(0, selected.start) + text + selected.value.slice(selected.end));
  expect(await fixture.readPage()).toMatchObject({ inputTrusted: true });
}

async function exposedControlPoint(fixture: UiLayerFixture, elementId: "action" | "editor", excluded: readonly OverlayBounds[]) {
  const box = await nativePageHole(fixture).boundingBox();
  assert(box);
  const local = await fixture.app.evaluate(async ({ webContents }, input) => {
    const target = webContents.fromId(input.id);
    if (!target) throw new Error("Native control target unavailable");
    return target.executeJavaScript(`(() => { const r=document.getElementById(${JSON.stringify(input.elementId)}).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
  }, { id: fixture.targetId, elementId });
  const point = await fixture.page.evaluate(({ box, local, excluded }) => {
    for (const localX of [local.x + 8, local.x + local.width - 8, local.x + local.width / 2]) {
      const point = { x: box.x + localX, y: box.y + local.y + local.height / 2 };
      if (point.x < box.x || point.x >= box.x + box.width || point.y < box.y || point.y >= box.y + box.height
        || excluded.some(rect => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height)) continue;
      if (document.elementFromPoint(point.x, point.y)?.closest("[data-ave-native-page]")) return point;
    }
    return null;
  }, { box, local, excluded });
  assert(point, `The native ${elementId} control has no uncovered interactive point`);
  return point;
}
