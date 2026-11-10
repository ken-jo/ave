import assert from "node:assert/strict";
import { expect, test, type Locator } from "@playwright/test";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { inspectBrowserTarget } from "./browser-native-target.js";
import { launchDecisionFixture, moveDecisionPageToMain } from "./browser-ui-decision-fixture.js";
import { captureOverlay, clickExposedAction, nativePageHole, scrollExposedPage, typeExposedEditor } from "./browser-ui-overlay-fixtures.js";
import { prepareNativeWindowCapture } from "./native-window-capture.js";

function allowSiteButton(dock: Locator) {
  return dock.getByTestId("browser-site-approval-card")
    .getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ });
}

async function takeOverPendingNavigation(fixture: Awaited<ReturnType<typeof launchDecisionFixture>>, dock: Locator,
  text: string) {
  const before = await fixture.control();
  expect(before.mode).toBe("agent-active");
  const allow = allowSiteButton(dock);
  await allow.focus();
  await expect(allow).toBeFocused();
  await allow.press("Tab");
  await expect(dock.getByRole("button", { name: /^(Allow any site|모든 사이트 허용)$/ })).toBeFocused();
  const bounds = await dock.boundingBox();
  assert(bounds);
  await scrollExposedPage(fixture, [bounds]);
  await expect(dock).toHaveCount(0);
  await expect.poll(fixture.toolReady).toBe(true);
  const paused = await fixture.control();
  expect(paused).toMatchObject({ mode: "human-paused", owner: before.owner, lease: null });
  expect(paused.generation).toBeGreaterThan(before.generation);
  expect(fixture.toolResults().at(-1)).toContain('"error"');
  expect(fixture.toolResults().at(-1)).toContain("browser control is paused; ask the user to resume this tab");
  await clickExposedAction(fixture);
  await typeExposedEditor(fixture, text);
  expect(await fixture.control()).toMatchObject({ url: fixture.url, mode: "human-paused", generation: paused.generation });
  expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
    .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
}

if (process.platform === "darwin") {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => { await prepareNativeWindowCapture(testInfo); });
  for (const width of [1360, 900]) {
    test(`ordinary work-panel site approval preserves page input and invalidates stale navigation at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchDecisionFixture(width);
      try {
        const dock = await fixture.requestNavigation();
        await expect(dock.locator("xpath=ancestor::*[@data-web-surface-occluder='settle']")).toHaveCount(0);
        await captureOverlay(fixture, dock, testInfo, `site-work-panel-${width}`, { overlap: false });
        await takeOverPendingNavigation(fixture, dock, "SITE");
      } finally { await fixture.close(); }
    });

    test(`natural browser move keeps the originating approval usable at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchDecisionFixture(width);
      try {
        const dock = await fixture.requestNavigation();
        await moveDecisionPageToMain(fixture, width, { allowSibling: true });
        await expect(fixture.page.getByTestId("pane-canvas")
          .locator(':scope > [data-testid^="pane-cell:"]:not([data-hidden="true"])')).toHaveCount(width === 1360 ? 2 : 1);
        expect(await dock.evaluate((element, tabId) => {
          const page = document.querySelector(`[data-ave-native-page][data-tab-id="${tabId}"]`);
          return element.closest('[data-testid="pane"]') === page?.closest('[data-testid="pane"]');
        }, fixture.rendererTabId)).toBe(width === 900);
        await captureOverlay(fixture, dock, testInfo, `site-natural-move-${width}`, { overlap: width === 900 });
        await takeOverPendingNavigation(fixture, dock, "MOVED");
      } finally { await fixture.close(); }
    });

    test(`main browser chat-panel approval and question stay interactive at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchDecisionFixture(width, { withDecisionPlugin: true });
      try {
        await moveDecisionPageToMain(fixture, width);
        const { work, side, dock, readRecord } = await fixture.startPaneApproval();
        await expect(dock.locator("xpath=ancestor::*[@data-web-surface-occluder='settle']")).toHaveCount(0);
        await captureOverlay(fixture, dock, testInfo, `chat-panel-approval-${width}`, { overlap: width === 900 });
        const workBounds = await work.boundingBox();
        assert(workBounds);
        await scrollExposedPage(fixture, [workBounds]);
        await expect(dock).toBeVisible();
        await clickExposedAction(fixture, [workBounds]);
        await typeExposedEditor(fixture, "PANE", [workBounds]);
        await expect(readRecord()).rejects.toMatchObject({ code: "ENOENT" });
        await dock.getByTestId(TEST_IDS.approveButton).click();
        await expect(dock).toHaveCount(0);
        await expect.poll(fixture.toolReady).toBe(true);
        expect(await readRecord()).toEqual({ recorded: true });
        const question = await fixture.requestQuestion();
        await expect(side.getByTestId("ask-user-question-card")).toHaveCount(1);
        await captureOverlay(fixture, question, testInfo, `chat-panel-question-${width}`, { overlap: width === 900 });
        const questionWorkBounds = await work.boundingBox();
        assert(questionWorkBounds);
        await scrollExposedPage(fixture, [questionWorkBounds]);
        await clickExposedAction(fixture, [questionWorkBounds]);
        await typeExposedEditor(fixture, "QUESTION", [questionWorkBounds]);
        await expect(question).toBeVisible();
        const choice = question.getByRole("option", { name: /Continue/ });
        await choice.focus();
        await expect(choice).toBeFocused();
        await choice.press("Enter");
        await expect(question).toHaveCount(0);
        await expect.poll(fixture.toolReady).toBe(true);
        const answer = fixture.toolResults().at(-1);
        assert(answer, "Pane question answer unavailable");
        expect(JSON.parse(answer)).toEqual({ answers: [{ choice: "Continue" }], dismissed: false });
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`genuine site approval and question stay above the same-pane page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchDecisionFixture(width);
      try {
        const dock = await fixture.requestNavigation();
        await moveDecisionPageToMain(fixture, width);
        await expect(dock.locator("xpath=ancestor::*[@data-web-surface-occluder='settle']")).toHaveCount(1);
        await captureOverlay(fixture, dock, testInfo, `site-settle-${width}`, { overlap: true });
        const before = await fixture.readPage();
        const allowSite = allowSiteButton(dock);
        const button = await allowSite.boundingBox();
        const page = await nativePageHole(fixture).boundingBox();
        assert(button && page);
        expect(button.x).toBeGreaterThanOrEqual(page.x);
        expect(button.y).toBeGreaterThanOrEqual(page.y);
        expect(button.x + button.width).toBeLessThanOrEqual(page.x + page.width);
        expect(button.y + button.height).toBeLessThanOrEqual(page.y + page.height);
        await allowSite.click();
        await expect(dock).toHaveCount(0);
        await expect.poll(fixture.toolReady).toBe(true);
        expect(await fixture.control()).toMatchObject({ url: fixture.secondUrl });
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.secondUrl))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
        expect((await fixture.readPage()).clicks).toBe(0);
        expect(before.clicks).toBe(1);

        const question = await fixture.requestQuestion();
        await expect(question.locator("xpath=ancestor::*[@data-web-surface-occluder='settle']")).toHaveCount(1);
        await captureOverlay(fixture, question, testInfo, `question-settle-${width}`, { overlap: true });
        const questionBounds = await question.boundingBox();
        assert(questionBounds);
        await scrollExposedPage(fixture, [questionBounds]);
        await expect(question).toBeVisible();
        await clickExposedAction(fixture, [questionBounds]);
        await expect(question).toBeVisible();
        await typeExposedEditor(fixture, "SETTLE", [questionBounds]);
        await expect(question).toBeVisible();
        const choice = question.getByRole("option", { name: /Continue/ });
        await choice.focus();
        await expect(choice).toBeFocused();
        await choice.press("Enter");
        await expect(question).toHaveCount(0);
        await expect.poll(fixture.toolReady).toBe(true);
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.secondUrl))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`genuine question stays usable beside a retained work-panel page at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchDecisionFixture(width);
      try {
        const question = await fixture.requestQuestion();
        await expect(question.locator("xpath=ancestor::*[@data-web-surface-occluder='settle']")).toHaveCount(0);
        await captureOverlay(fixture, question, testInfo, `question-work-panel-${width}`, { overlap: width === 900 });
        const questionBounds = await question.boundingBox();
        assert(questionBounds);
        await scrollExposedPage(fixture, [questionBounds]);
        await expect(question).toBeVisible();
        await clickExposedAction(fixture, [questionBounds]);
        await typeExposedEditor(fixture, "QUESTION", [questionBounds]);
        await expect(question).toBeVisible();
        await question.getByRole("option", { name: /Continue/ }).click();
        await expect(question).toHaveCount(0);
        await expect.poll(fixture.toolReady).toBe(true);
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });

    test(`genuine governed tool approval stays usable in the right lane at ${width}x800`, async ({ browserName: _browserName }, testInfo) => {
      const fixture = await launchDecisionFixture(width, { withDecisionPlugin: true });
      try {
        const { lane, readResult, readRecord } = await fixture.startLaneApproval();
        await expect(lane).toHaveRole("region");
        await expect(fixture.page.getByTestId(TEST_IDS.approvalDock)).toHaveCount(0);
        const controlBeforeReveal = await fixture.control();
        expect(controlBeforeReveal.mode).toBe("agent-active");
        await fixture.page.locator(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${fixture.rendererTabId}"]`)
          .getByRole("tab").click();
        await expect(nativePageHole(fixture)).toBeVisible();
        await expect.poll(async () => (await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url)).attached).toBe(true);
        expect(await fixture.control()).toMatchObject({
          mode: "agent-active", generation: controlBeforeReveal.generation, owner: controlBeforeReveal.owner,
        });
        await expect(lane).toBeVisible();
        await captureOverlay(fixture, lane, testInfo, `governed-right-lane-${width}`, { overlap: width === 900 });
        const laneBounds = await lane.boundingBox();
        assert(laneBounds);
        await scrollExposedPage(fixture, [laneBounds]);
        await expect(lane).toBeVisible();
        await clickExposedAction(fixture, [laneBounds]);
        await typeExposedEditor(fixture, "LANE", [laneBounds]);
        await expect(lane).toBeVisible();
        await expect(readRecord()).rejects.toMatchObject({ code: "ENOENT" });
        const approve = lane.getByTestId(TEST_IDS.approveButton);
        await approve.focus();
        await expect(approve).toBeFocused();
        await approve.press("Enter");
        await expect(lane).toHaveCount(0);
        expect(await readResult()).toEqual({ recorded: true });
        expect(await readRecord()).toEqual({ recorded: true });
        expect(await inspectBrowserTarget(fixture.app, fixture.host.windowId, fixture.url))
          .toMatchObject({ id: fixture.targetId, attached: true, ownerFocused: false });
      } finally { await fixture.close(); }
    });
  }
}
