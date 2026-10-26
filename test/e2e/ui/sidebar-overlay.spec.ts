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
        const last = page.getByTestId("sidebar-hide");
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
