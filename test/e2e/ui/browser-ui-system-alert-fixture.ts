import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type TestInfo } from "@playwright/test";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { nativePageHole, scrollExposedPage, typeExposedEditor } from "./browser-ui-overlay-fixtures.js";
import { captureNativeWindow, sampleNativeWindow } from "./native-window-capture.js";
import { REPO_ROOT } from "./seeded-electron.js";

const run = promisify(execFile);
const FAILURE = "Model native-ui-layer-fixture is unavailable";

export async function exerciseSystemAlert(width: number, formatting: boolean, testInfo: TestInfo) {
  const fixture = await launchUiLayerFixture(width);
  const { app, page, composer } = fixture;
  try {
    await fixture.clickFromAgent();
    await composer.fill("Keep this composer draft while the provider reports its failure.");
    await composer.evaluate(editor => {
      const state = { editor, blurs: 0 };
      Reflect.set(window, "systemAlertComposer", state);
      editor.addEventListener("blur", () => { state.blurs++; });
    });
    const nativeBefore = await inspectBrowserTarget(app, fixture.host.windowId, fixture.url);
    const stream: unknown[] = [];
    await page.evaluate(() => {
      const events: unknown[] = [];
      Reflect.set(window, "systemAlertStream", events);
      window.aveApi.onChatStream(event => { events.push(event); });
    });
    const rawFailure = FAILURE;
    fixture.failAfterPageClick(rawFailure);
    const body = page.getByTestId("assistant-message-body").filter({ hasText: FAILURE });
    await expect(body).toHaveCount(1);
    await expect(body).toBeVisible();
    await expect(page.getByRole("button", { name: /^(LLM 취소|Cancel LLM)/ })).toHaveCount(0);
    await expect.poll(() => body.evaluate(element => {
      const card = element.parentElement;
      if (!card) throw new Error("System alert card unavailable");
      return card.getAnimations({ subtree: true }).every(animation => animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY || animation.playState === "finished" || animation.playState === "idle");
    })).toBe(true);
    const history = await page.evaluate(() => window.aveApi.chatGetHistory());
    const hole = nativePageHole(fixture);
    const pageRect = await hole.boundingBox();
    assert(pageRect);
    const geometry = await body.evaluate(element => {
      const card = element.parentElement;
      const column = element.closest('[data-testid="chat-main-column"]');
      if (!(card instanceof HTMLElement) || !(column instanceof HTMLElement)) throw new Error("System alert owner column unavailable");
      const columnBounds = column.getBoundingClientRect();
      const page = document.querySelector("[data-ave-native-page]");
      if (!page) throw new Error("Live native page unavailable");
      const pageBounds = page.getBoundingClientRect();
      const describeElement = (node: Element) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { tag: node.tagName, testId: node.getAttribute("data-testid"), className: node.getAttribute("class"),
          bounds: rect.toJSON(), display: style.display, visibility: style.visibility, opacity: style.opacity,
          width: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth, flex: style.flex,
          overflowX: style.overflowX, overflowY: style.overflowY, clipPath: style.clipPath,
          background: style.backgroundColor, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
      };
      const visible = (node: Element) => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 && style.visibility === "visible"
          && style.display !== "none" && Number(style.opacity) > 0 && rect.bottom > 0 && rect.top < innerHeight;
      };
      const intersectsPage = (rect: DOMRect) => rect.right > pageBounds.left && rect.left < pageBounds.right
        && rect.bottom > pageBounds.top && rect.top < pageBounds.bottom;
      const outsideColumn = (rect: DOMRect) => rect.left < columnBounds.left - 0.5 || rect.right > columnBounds.right + 0.5;
      const descendants = Array.from(column.querySelectorAll("*")).filter(visible).map(node => ({
        ...describeElement(node), outsideColumn: outsideColumn(node.getBoundingClientRect()), crossesPage: intersectsPage(node.getBoundingClientRect()),
      }));
      const textRuns: Array<{ text: string; parent: ReturnType<typeof describeElement>; bounds: { x: number; y: number; left: number; right: number; top: number; bottom: number; width: number; height: number }; outsideColumn: boolean; crossesPage: boolean }> = [];
      const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || !text.parentElement || !visible(text.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
          textRuns.push({ text: text.textContent, parent: describeElement(text.parentElement), bounds: rect.toJSON(),
            outsideColumn: outsideColumn(rect), crossesPage: intersectsPage(rect) });
        }
      }
      const ancestors = [];
      for (let ancestor: Element | null = card; ancestor; ancestor = ancestor.parentElement) ancestors.push(describeElement(ancestor));
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      if (!context) throw new Error("System alert surface color unavailable");
      context.fillStyle = getComputedStyle(card).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return { column: describeElement(column), page: describeElement(page), card: describeElement(card), ancestors, descendants, textRuns,
        outsideElements: descendants.filter(node => node.outsideColumn && node.crossesPage),
        outsideText: textRuns.filter(node => node.outsideColumn && node.crossesPage),
        cardBackgroundRGBA: [...context.getImageData(0, 0, 1, 1).data],
        displayed: element.textContent, prefixCount: element.textContent?.match(/오류\s*:|오류가 발생했습니다\s*:|Error\s*:|An error occurred\s*:/g)?.length ?? 0 };
    });
    const scripts = await page.evaluate(() => Array.from(document.scripts).map(script => script.src).filter(source => source.startsWith("file:")));
    const sourceFiles = ["src/ui/renderer/components/AssistantCard.tsx", "src/ui/renderer/ChatView.tsx",
      "src/engine/turn/stream-collector.ts", "src/ui/renderer/hooks/use-chat-state.ts", "src/ui/renderer/hooks/use-side-chat.ts"];
    const hashes = async (paths: string[]) => Promise.all(paths.map(async path => ({ path,
      sha256: createHash("sha256").update(await fs.readFile(path)).digest("hex") })));
    const sourceDiff = (await run("git", ["-C", REPO_ROOT, "diff", "HEAD", "--", "src"])).stdout;
    const mainChunkDirectory = join(REPO_ROOT, "dist/src/main/chunks");
    const builtMainFiles = [join(REPO_ROOT, "dist/src/main/main.js"), join(REPO_ROOT, "dist/src/preload.cjs"),
      ...(await fs.readdir(mainChunkDirectory)).filter(path => path.endsWith(".js")).sort().map(path => join(mainChunkDirectory, path))];
    const provenance = {
      status: (await run("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", "src"])).stdout,
      sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
      sourceFiles: await hashes(sourceFiles.map(path => join(REPO_ROOT, path))),
      loadedBundles: await hashes(scripts.map(source => fileURLToPath(source))),
      mainAndPreloadBundles: await hashes(builtMainFiles),
    };
    const name = `system-alert-${formatting ? "prefix" : "layout"}-${width}`;
    const capture = await captureNativeWindow(app, page, testInfo, name);
    const cardPoint = { x: geometry.card.bounds.x + 8, y: geometry.card.bounds.bottom - 8 };
    const right = Math.min(geometry.card.bounds.right, pageRect.x + pageRect.width - 24);
    const left = Math.max(geometry.card.bounds.left, pageRect.x + 24);
    const top = Math.max(geometry.card.bounds.top, pageRect.y + 8);
    const bottom = Math.min(geometry.card.bounds.bottom, pageRect.y + pageRect.height - 24);
    const pagePoint = right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 }
      : { x: pageRect.x + pageRect.width / 2, y: pageRect.y + pageRect.height - 40 };
    const expectedPage = await app.evaluate(async ({ webContents }, input) => {
      const target = webContents.fromId(input.id);
      if (!target) throw new Error("System alert native pixel target unavailable");
      const zoom = target.getZoomFactor();
      const image = await target.capturePage({ x: Math.floor(input.x * zoom), y: Math.floor(input.y * zoom), width: 1, height: 1 });
      const bitmap = image.toBitmap();
      return [bitmap[2], bitmap[1], bitmap[0], bitmap[3]];
    }, { id: fixture.targetId, x: pagePoint.x - pageRect.x, y: pagePoint.y - pageRect.y });
    const pixels = await sampleNativeWindow(app, capture, [cardPoint, pagePoint]);
    stream.push(...await page.evaluate(() => Reflect.get(window, "systemAlertStream")));
    const focus = await composer.evaluate(() => {
      const state = Reflect.get(window, "systemAlertComposer") as { editor: Element; blurs: number };
      return { active: document.activeElement === state.editor, blurs: state.blurs };
    });
    const proof = { width, rawFailure, failures: fixture.modelFailures(), provenance, geometry,
      cardPoint, pagePoint, expectedPage, pixels, stream, history, focus,
      nativeBefore, nativeAfter: await inspectBrowserTarget(app, fixture.host.windowId, fixture.url), pageState: await fixture.readPage() };
    const proofPath = testInfo.outputPath(`${name}-geometry.json`);
    await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    await testInfo.attach(`${name}-geometry`, { path: proofPath, contentType: "application/json" });
    expect(fixture.modelFailures()).toContainEqual({ status: 404, message: rawFailure, model: "native-ui-layer-fixture" });
    expect(proof.pageState).toMatchObject({ clicks: 2, trusted: true, activation: true });
    expect(focus).toEqual({ active: true, blurs: 0 });
    await expect(composer).toHaveValue("Keep this composer draft while the provider reports its failure.");
    if (formatting) {
      expect(geometry.prefixCount).toBe(1);
    } else {
      expect.soft(geometry.card.bounds.left).toBeGreaterThanOrEqual(geometry.column.bounds.left);
      expect.soft(geometry.card.bounds.right).toBeLessThanOrEqual(geometry.column.bounds.right);
      expect.soft(geometry.outsideElements).toEqual([]);
      expect.soft(geometry.outsideText).toEqual([]);
      expect.soft(geometry.cardBackgroundRGBA[3]).toBe(255);
      expect.soft(pixels[0]).toEqual(geometry.cardBackgroundRGBA);
      expect.soft(pixels[1]).toEqual(expectedPage);
    }
    await scrollExposedPage(fixture, [geometry.card.bounds]);
    await typeExposedEditor(fixture, "ALERT", [geometry.card.bounds]);
    expect(await fixture.readPage()).toMatchObject({ value: "ALERT", inputTrusted: true });
  } finally { await fixture.close(); }
}
