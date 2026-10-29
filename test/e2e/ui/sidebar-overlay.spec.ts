import { test, expect } from "@playwright/test";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

test("fits a saved wide sidebar inside a narrow window and restores its preferred width", async ({}, testInfo) => {
  const context = await launchSeededElectron({
    sessionId: "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee",
    historyRows: [],
    settings: { ...buildLlmSettings(), system: { sidebarState: "expanded", sidebarWidth: 480 } },
  });
  try {
    const { page } = context;
    for (const width of [360, 900, 1243]) {
      await setWindowSize(context.app, width, 768);
      const card = page.getByTestId("sidebar-card");
      const overlay = width === 360;
      if (overlay) await expect(page.getByTestId("primary-sidebar")).toHaveAttribute("data-sidebar-overlay", "true");
      else await expect(page.getByTestId("primary-sidebar")).not.toHaveAttribute("data-sidebar-overlay");
      await expect.poll(async () => {
        const bounds = (await card.boundingBox())!;
        return bounds.width <= width && bounds.x >= 0 && bounds.x + bounds.width <= width;
      }).toBe(true);
      if (!overlay) await expect(card).toHaveCSS("width", "480px");
      const handle = await page.getByTestId("sidebar-resize-handle").boundingBox();
      expect(handle).not.toBeNull();
      expect(handle!.x + handle!.width).toBeLessThanOrEqual(width);
      const saved = await page.evaluate(() => window.aveApi.getSettings());
      expect(saved.system.sidebarWidth).toBe(480);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (overlay) {
        const first = page.getByTestId("sidebar-resize-handle");
        const last = page.getByTestId("sidebar-settings");
        await last.focus();
        await page.keyboard.press("Tab");
        await expect(first).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(last).toBeFocused();
      }
      await page.screenshot({ path: testInfo.outputPath(`sidebar-wide-preference-${width}.png`) });
    }
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});

test("restores a saved hidden sidebar and keeps one collapse control", async ({}, testInfo) => {
  const context = await launchSeededElectron({
    sessionId: "e2000001-bb11-4cc2-8dd3-eeeeeeeeeeee",
    historyRows: [],
    settings: { ...buildLlmSettings(), system: { sidebarState: "hidden" } },
  });
  try {
    const { page } = context;
    await expect(page.getByTestId("sidebar-show")).toBeVisible();
    await expect(page.getByTestId("primary-sidebar")).toHaveCount(0);
    await page.getByTestId("sidebar-show").click();
    await expect(page.getByTestId("sidebar-collapse-toggle")).toHaveCount(1);
    await expect(page.getByTestId("sidebar-hide")).toHaveCount(0);
    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(page.getByTestId("sidebar-collapse-toggle")).toHaveAttribute("aria-pressed", "false");
    const shortcut = process.platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B";
    await page.keyboard.press(shortcut);
    await expect(page.getByTestId("sidebar-show")).toBeVisible();
    await expect(page.getByTestId("sidebar-show")).toBeFocused();
    await page.keyboard.press(shortcut);
    await expect(page.getByTestId("sidebar-collapse-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("sidebar-collapse-toggle")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("single-sidebar-control.png") });
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});
