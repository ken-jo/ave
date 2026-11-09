import { writeFile } from "node:fs/promises";
import { setWindowSize } from "./seeded-electron.js";
import type { ElectronApplication, Locator, Page } from "playwright";
import { test, expect } from "./fixtures.js";
import { test as providerTest } from "../../screenshots/fixtures.js";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../../../src/contract/app-contract.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

async function captureWindow(app: ElectronApplication, path: string, width: number) {
  const capture = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("Missing main window");
    await win.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const image = await win.webContents.capturePage();
    return { png: image.toPNG().toString("base64"), size: image.getSize() };
  });
  expect(capture.size).toEqual({ width, height: 640 });
  await writeFile(path, Buffer.from(capture.png, "base64"));
}

async function expectUnclippedHit(control: Locator) {
  await expect(control).toBeVisible();
  const hit = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let clipped = false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (style.overflowX !== "visible" && (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5)) clipped = true;
    }
    return {
      width: box.width, height: box.height,
      hit: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
      left: box.left, right: box.right, viewport: window.innerWidth, clipped,
    };
  });
  expect(hit.width).toBeGreaterThan(0);
  expect(hit.height).toBeGreaterThan(0);
  expect(hit.left).toBeGreaterThanOrEqual(0);
  expect(hit.right).toBeLessThanOrEqual(hit.viewport);
  expect(hit.clipped, JSON.stringify(hit)).toBe(false);
  expect(hit.hit, JSON.stringify(hit)).toBe(true);
}

async function expectControlReceivesClick(control: Locator) {
  await expectUnclippedHit(control);
  const target = await control.elementHandle();
  if (!target) throw new Error("Missing control");
  await target.evaluate((element) => element.addEventListener("click", () => element.setAttribute("data-answer-clicked", "true"), { once: true }));
  await control.click();
  expect(await target.evaluate((element) => element.getAttribute("data-answer-clicked"))).toBe("true");
  await target.dispose();
}

async function activateView(app: ElectronApplication, viewKey: string) {
  await app.evaluate(({ BrowserWindow }, { channel, viewKey }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { viewKey });
  }, { channel: CHANNELS.view.activate, viewKey });
}

async function clearHistory(page: Page) {
  await page.getByTestId("notification-bell").click();
  const clear = page.getByTestId("notification-history-clear-all");
  if (await clear.isEnabled()) await clear.click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("notification-center")).toHaveCount(0);
}

async function showInstallNotice(app: ElectronApplication, slug: string, success: boolean) {
  await app.evaluate(({ BrowserWindow }, { channel, slug, success }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, {
      slug, success,
      ...(!success ? { error: "install-failed", message: "The install could not finish. Review the settings and try again." } : {}),
    });
  }, { channel: CHANNELS.plugins.installResult, slug, success });
}

for (const width of [360, 1243]) {
  test(`window notices stay in the bell history at ${width}px`, async ({ app, mainWindow: page }, testInfo) => {
    await setWindowSize(app, width, 640);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("composer-textarea").first().waitFor();
    await clearHistory(page);
    const canvas = page.getByTestId(TEST_IDS.routeCanvas);
    const before = await canvas.boundingBox();
    await showInstallNotice(app, "bell-install-result", true);
    await expect(page.getByTestId("notification-bell-count")).toHaveText("1");
    await expect(page.getByTestId("window-notice-slot")).toHaveCount(0);
    await expect(page.getByTestId("status-toast")).toHaveCount(0);
    expect(await canvas.boundingBox()).toEqual(before);
    await expect(page.getByTestId("window-notice-strip").getByTestId("notice-live-polite")).toContainText("bell-install-result");

    const bell = page.getByTestId("notification-bell");
    await expectUnclippedHit(bell);
    await bell.focus();
    await page.keyboard.press("Enter");
    const center = page.getByTestId("notification-center");
    await expect(center).toHaveAttribute("role", "dialog");
    await expect(center).not.toHaveAttribute("aria-live");
    const approvals = center.getByTestId("notification-approvals");
    await expect(approvals.getByTestId("work-approvals-empty")).toHaveText("Nothing to review");
    await expect(approvals.getByTestId("work-approvals-popover-view-all")).toHaveCount(0);
    await expect(approvals.locator("footer")).toHaveCount(0);
    const row = center.getByTestId("notification-history-row").filter({ hasText: "bell-install-result" });
    await expect(row).toBeVisible();
    await expect(row.locator("time")).toBeVisible();
    await expect(page.getByTestId("notification-bell-count")).toHaveCount(0);
    await captureWindow(app, testInfo.outputPath(`notification-bell-open-${width}.png`), width);
    await expectControlReceivesClick(row.getByTestId("notification-history-clear"));
    await expect(row).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(center).toHaveCount(0);
    await expect(bell).toBeFocused();

    await showInstallNotice(app, "bell-error-result", false);
    await expect(page.getByTestId("notification-bell-count")).toHaveText("1");
    const errorDot = page.getByTestId("notification-bell-error");
    await expect(errorDot).toHaveClass(/bg-destructive/);
    await expect(page.getByTestId("window-notice-strip").getByTestId("notice-live-assertive")).toContainText("bell-error-result");
    await expect(page.getByTestId("status-toast")).toHaveCount(0);
    await bell.click();
    await expect(center.getByTestId("notification-history-row").filter({ hasText: "bell-error-result" })).toBeVisible();
    await expect(errorDot).toHaveCount(0);
    await center.getByTestId("notification-history-clear-all").click();
    await expect(center.getByTestId("notification-history-row")).toHaveCount(0);
    await page.keyboard.press("Escape");

    const composer = page.getByTestId("composer-textarea").first();
    const composerBounds = await composer.boundingBox();
    await app.evaluate(({ BrowserWindow }, { channel, chatGroupId }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(channel, { chatGroupId, from: "primary/model", to: "secondary/model" });
    }, { channel: CHANNELS.chat.fallback, chatGroupId: MAIN_CHAT_GROUP_ID });
    const localNotice = page.getByTestId("composer-toast-dock").getByTestId("status-toast");
    await expect(localNotice).toBeVisible();
    await expect(localNotice).toContainText("secondary/model");
    await expect(page.getByTestId("notification-bell-count")).toHaveCount(0);
    expect(await composer.boundingBox()).toEqual(composerBounds);
    await localNotice.getByTestId("status-toast-dismiss").click();
    await expect(localNotice).toHaveCount(0);
  });

  test(`a work approval in the bell navigates to its card at ${width}px`, async ({ app, mainWindow: page }) => {
    await setWindowSize(app, width, 640);
    await clearHistory(page);
    const routineId = await page.evaluate(async () => {
      const approvals = await window.aveApi.listWorkApprovals?.({ allProjects: true });
      if (!approvals?.ok) throw new Error("Missing work approvals projection");
      const project = approvals.projects.find((entry) => entry.isDefault);
      if (!project) throw new Error("Missing default project");
      const added = await window.aveApi.addRoutine({
        title: "Review missing routine dependency", trigger: "schedule", execution: "llm-session",
        projectRoot: project.projectRoot, prePrompt: "Review the reports folder",
        schedule: { at: new Date(Date.now() + 86_400_000).toISOString(), repeat: { kind: "none" } },
        scope: { pluginIds: { mode: "allow", ids: ["missing-bell-dependency"] }, forcedPluginIds: [], directories: [] },
      });
      if (!added.ok) throw new Error(added.error);
      const triggered = await window.aveApi.triggerRoutineNow(added.routine.id);
      if (triggered.ok || triggered.error !== "plugins-missing") throw new Error("Routine did not require attention");
      return added.routine.id;
    });
    await expect(page.getByTestId("notification-bell-count")).toHaveText("1");
    await page.getByTestId("notification-bell").click();
    const section = page.getByTestId("notification-approvals");
    const row = section.getByTestId("work-approvals-popover-row").filter({ hasText: "Review missing routine dependency" });
    await expect(row).toHaveAttribute("data-approval-key", `routine:${routineId}`);
    await expect(row.getByRole("button")).toHaveCount(0);
    await row.click();
    await expect(page.getByTestId("notification-center")).toHaveCount(0);
    const card = page.getByTestId("work-approval-head").filter({ hasText: "Review missing routine dependency" });
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    const current = await page.evaluate(() => window.aveApi.listWorkApprovals?.({ allProjects: true }));
    expect(current?.ok && current.items.some((item) => item.key === `routine:${routineId}`)).toBe(true);
    await expect(page.getByTestId("notification-bell-count")).toHaveText("1");
  });
}

for (const width of [360, 1243]) {
  test(`a main notification keeps its identity across renderer reloads at ${width}px`, {
    annotation: { type: "isolated-app", description: "Intercepts process-wide OS notification presentation" },
  }, async ({ app, mainWindow: page }, testInfo) => {
    await setWindowSize(app, width, 640);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await clearHistory(page);
    const previousNodeEnv = await app.evaluate(() => process.env.NODE_ENV);
    try {
      // The isolated UI fixture starts in test mode, which suppresses passive notifications.
      await app.evaluate(({ Notification }) => {
        const state = globalThis as typeof globalThis & {
          __aveE2eNotificationShow?: { original: typeof Notification.prototype.show; calls: number };
        };
        if (state.__aveE2eNotificationShow) throw new Error("Notification presentation is already intercepted");
        state.__aveE2eNotificationShow = { original: Notification.prototype.show, calls: 0 };
        Notification.prototype.show = () => {
          const interceptor = state.__aveE2eNotificationShow;
          if (!interceptor) throw new Error("Notification presentation interceptor is missing");
          interceptor.calls += 1;
        };
        process.env.NODE_ENV = "production";
      });
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()))).toBe(false);
      const result = await page.evaluate(() => window.ave.mcp.postUiMessage("e2e-history", "", {
        content: [{ type: "text", text: "Reload history", _meta: {
          "ai.agent-connector.ave/notification": { title: "Reload history", body: "Keep across reload" },
        } }],
      }));
      expect(result).toEqual({ ok: true, disposition: "notified" });
      expect(await app.evaluate(() => (globalThis as typeof globalThis & {
        __aveE2eNotificationShow?: { calls: number };
      }).__aveE2eNotificationShow?.calls)).toBe(1);
      await expect(page.getByTestId("notification-bell-count")).toHaveText("1");
      await expect(page.getByTestId("status-toast")).toHaveCount(0);
      await page.getByTestId("notification-bell").click();
      const row = page.getByTestId("notification-history-row").filter({ hasText: "Keep across reload" });
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      const id = await row.getAttribute("data-notice-id");
      const createdAt = await row.locator("time").getAttribute("datetime");
      expect(id).toMatch(/^notification:main:/);
      expect(createdAt).toBeTruthy();

      for (const cleared of [false, true]) {
        if (cleared) {
          await row.getByTestId("notification-history-clear").click();
          await expect(row).toHaveCount(0);
        }
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("main-toolbar")).toBeVisible();
        await expect(page.getByTestId("composer-textarea").first()).toBeVisible();
        await page.getByTestId("notification-bell").click();
        await expect(row).toHaveCount(1);
        await expect(row).toHaveAttribute("data-notice-id", id ?? "");
        await expect(row.locator("time")).toHaveAttribute("datetime", createdAt ?? "");
        await expect(page.getByTestId("notification-bell-count")).toHaveCount(0);
      }
      await captureWindow(app, testInfo.outputPath(`notification-bell-reloaded-${width}.png`), width);
    } finally {
      await app.evaluate(({ Notification }, previous) => {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
        const state = globalThis as typeof globalThis & {
          __aveE2eNotificationShow?: { original: typeof Notification.prototype.show; calls: number };
        };
        if (!state.__aveE2eNotificationShow) throw new Error("Notification presentation interceptor is missing");
        Notification.prototype.show = state.__aveE2eNotificationShow.original;
        delete state.__aveE2eNotificationShow;
      }, previousNodeEnv);
    }
  });
}

for (const [width, zoomLevel] of [[360, 0], [360, 2], [1243, 0]] as const) {
  test(`the bell and update controls hit-test at ${width}px and zoom ${zoomLevel}`, async ({ app, mainWindow: page }, testInfo) => {
    await setWindowSize(app, width, 640);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(async (zoomLevel) => {
      await window.aveApi.updateSettings({ appearance: { zoomLevel } });
    }, zoomLevel);
    await expect.poll(() => page.evaluate(async () => (await window.aveApi.getSettings()).appearance.zoomLevel)).toBe(zoomLevel);
    await clearHistory(page);
    await activateView(app, "settings");
    await expect(page.getByRole("searchbox")).toBeVisible();
    await app.evaluate(({ BrowserWindow }, channels) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      contents?.send(channels.update.state, { kind: "available", version: "9.9.9" });
      contents?.send(channels.marketplace.updatesAvailable, [{
        key: { sourceId: "ave", kind: "plugin", name: "notice-update" },
        displayName: "Notice update", from: "1.0.0", to: "2.0.0", state: "manual",
      }]);
    }, CHANNELS);
    await showInstallNotice(app, "bell-controls-error", false);
    await expect(page.getByTestId("notification-bell-error")).toBeVisible();
    const bell = page.getByTestId("notification-bell");
    await expectUnclippedHit(bell);
    expect(await bell.evaluate((element) => element.closest('[data-testid="toolbar-status-menu"]') === null)).toBe(true);
    await expectUnclippedHit(page.getByTestId(TEST_IDS.viewPathBack));
    await expectControlReceivesClick(page.getByTestId(TEST_IDS.viewPathBack));
    await expect(page.getByTestId("composer-textarea").first()).toBeVisible();
    await expectControlReceivesClick(page.getByTestId("view-path-forward"));
    await expect(page.getByRole("searchbox")).toBeVisible();

    if (width < 768) {
      await expect(page.getByTestId("app-update-badge-available")).toHaveCount(0);
      await expect(page.getByTestId("marketplace-update-action")).toHaveCount(0);
      await expectControlReceivesClick(page.getByTestId("toolbar-status-overflow"));
      const menu = page.getByTestId("toolbar-status-menu");
      await expect(menu).toBeVisible();
      await expect(menu.getByTestId("notification-bell")).toHaveCount(0);
      await expectUnclippedHit(page.getByTestId("app-update-badge-available"));
      await expect(page.getByTestId("marketplace-update-action")).toHaveAttribute("role", "menuitem");
    } else {
      await expect(page.getByTestId("toolbar-status-overflow")).toHaveCount(0);
      await expectUnclippedHit(page.getByTestId("app-update-badge-available"));
    }
    await expectControlReceivesClick(page.getByTestId("marketplace-update-action"));
    const review = page.getByTestId("git-marketplace:sheet");
    await expect(review).toBeVisible();
    await expect(review).toContainText("notice-update");
    await expect(page.getByTestId("toolbar-status-menu")).toHaveCount(0);
    await expectControlReceivesClick(page.getByTestId("git-marketplace:sheet:close"));
    await expectControlReceivesClick(bell);
    const row = page.getByTestId("notification-history-row").filter({ hasText: "bell-controls-error" });
    await expectUnclippedHit(row.getByTestId("notification-history-clear"));
    await captureWindow(app, testInfo.outputPath(`notification-controls-${width}-zoom-${zoomLevel}.png`), width);
    await row.getByTestId("notification-history-clear").click();
    await expect(row).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(bell).toBeFocused();
  });
}

test.describe("persistent banner history", () => {
  test.use({ seedLlmProvider: "copilot", seedLocale: "en" });
  for (const width of [360, 1243]) {
    test(`a banner keeps its place and its action in the bell at ${width}px`, async ({ app, mainWindow: page }) => {
      await setWindowSize(app, width, 640);
      const banner = page.getByTestId("retired-provider-notice");
      await expect(banner).toBeVisible();
      const title = await banner.locator("span.font-medium, span.block.font-medium").first().textContent();
      if (!title) throw new Error("Missing banner title");
      const action = await banner.getByTestId("retired-provider-notice-action").textContent();
      if (!action) throw new Error("Missing banner action");
      await page.getByTestId("notification-bell").click();
      const row = page.getByTestId("notification-history-row").filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(banner).toBeVisible();
      await row.getByRole("button", { name: action, exact: true }).click();
      await expect(page.getByTestId("notification-center")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
      await expect(page.getByRole("searchbox")).toBeVisible();
      await expect(page.getByRole("tab", { name: "Model", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(banner).toBeVisible();
    });
  }
});

providerTest.describe("side-chat notice delivery", () => {
  providerTest.use({
    reviewerMode: "disabled",
    executionMode: "default",
    scriptedScript: {
      unavailableModels: ["unavailable-model"],
      turns: [
        { expect: "assistant", parts: [{ kind: "tool", id: "notice-side-question", name: "ask_user_question", input: {
          questions: [{ question: "Continue the side conversation?", choices: ["Continue", "Stop"] }],
        } }] },
        { expect: "assistant", parts: [{ kind: "text", text: "Recorded side answer." }] },
      ],
    },
  });

  for (const width of [360, 1243]) {
    providerTest(`real fallback and question delivery preserve the side chat at ${width}px`, async ({ app, mainWindow: page, scriptedProvider }, testInfo) => {
      if (!scriptedProvider) throw new Error("Missing scripted provider");
      await setWindowSize(app, width, 640);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(async () => {
        const current = await window.aveApi.getSettings();
        const result = await window.aveApi.updateSettings({ llm: {
          vendors: { ...current.llm.vendors, "openai-compatible": {
            ...current.llm.vendors["openai-compatible"], model: "unavailable-model",
          } },
          fallbackChain: [{ provider: "openai-compatible", model: "local-model" }],
        } });
        if ("ok" in result && !result.ok) throw new Error(result.error);
      });
      await expect(page.locator('[data-composer-surface="main"] [data-testid="iab-status-model"]')).toContainText("unavailable-model");
      await page.getByTestId(TEST_IDS.panePanelToggle).click();
      await page.getByTestId(chatSidePanelLauncherTestId("side-chat")).click();
      const side = page.getByTestId("side-chat-view");
      const composer = side.getByTestId("composer-textarea");
      const transcript = side.getByTestId("side-chat-transcript");
      await expect(composer).toBeVisible();
      const before = { composer: await composer.boundingBox(), transcript: await transcript.boundingBox() };
      await composer.fill("Keep the reading position");
      await side.getByTestId("composer-send-button").click();
      const toast = side.getByTestId("status-toast");
      const card = side.getByTestId("ask-user-question-card");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText("unavailable-model");
      await expect(toast).toContainText("local-model");
      expect(await composer.boundingBox()).toEqual(before.composer);
      expect(await transcript.boundingBox()).toEqual(before.transcript);
      const newSession = side.getByTestId("side-chat-new");
      const toolbarBounds = await newSession.boundingBox();
      const contentBounds = await side.getByTestId("side-chat-content").boundingBox();
      const toastBounds = await toast.boundingBox();
      if (!toolbarBounds || !contentBounds || !toastBounds || !before.composer) throw new Error("Missing side chat bounds");
      expect(contentBounds.y).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height);
      expect(toastBounds.y).toBeGreaterThanOrEqual(contentBounds.y);
      expect(toastBounds.y + toastBounds.height).toBeLessThanOrEqual(before.composer.y);
      await expectControlReceivesClick(page.getByRole("tab", { name: /Side chat/ }));
      const answer = card.getByRole("option", { name: "Continue", exact: true });
      expect(await answer.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      })).toBe(true);
      const overlap = await card.evaluate((element) => {
        const notice = element.closest('[data-testid="side-chat-view"]')?.querySelector('[data-testid="status-toast"]');
        if (!notice) throw new Error("Missing concurrent notice");
        const toastBox = notice.getBoundingClientRect();
        const cardBox = element.getBoundingClientRect();
        const left = Math.max(toastBox.left, cardBox.left);
        const right = Math.min(toastBox.right, cardBox.right);
        const top = Math.max(toastBox.top, cardBox.top);
        const bottom = Math.min(toastBox.bottom, cardBox.bottom);
        const overlaps = left < right && top < bottom;
        return { overlaps, cardOwnsHit: overlaps && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)) };
      });
      expect(overlap).toEqual({ overlaps: true, cardOwnsHit: true });
      await page.screenshot({ path: testInfo.outputPath("side-chat-notice-and-question.png") });
      await answer.click();
      await expect(card).toHaveCount(0);
      await expect(transcript).toContainText("Recorded side answer.", { timeout: 30_000 });
      const fallbackIndex = scriptedProvider.requestedModels.indexOf("local-model");
      expect(fallbackIndex).toBeGreaterThan(0);
      expect(scriptedProvider.requestedModels.slice(0, fallbackIndex).every((model) => model === "unavailable-model")).toBe(true);
      const answeredQuestion = scriptedProvider.toolResponses.map((response) => JSON.parse(response) as { tool_call_id: string; content: unknown })
        .find((response) => response.tool_call_id === "notice-side-question");
      expect(JSON.stringify(answeredQuestion?.content)).toContain("Continue");
      expect(scriptedProvider.violations).toEqual([]);
      await testInfo.attach("provider-delivery", { body: JSON.stringify({
        requestedModels: scriptedProvider.requestedModels, toolResponses: scriptedProvider.toolResponses,
      }, null, 2), contentType: "application/json" });
      await toast.getByTestId("status-toast-dismiss").click();
      await expect(toast).toHaveCount(0);
      expect(await composer.boundingBox()).toEqual(before.composer);
      expect(await transcript.boundingBox()).toEqual(before.transcript);
    });
  }
});
