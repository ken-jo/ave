import { test, expect } from "@playwright/test";
import { buildLlmSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

// A real renderer measures truncation; the component tests cover assignment and actions.
test("keeps stacked sections and mixed rows inside a narrow sidebar", async ({}, testInfo) => {
  expect(builtMainExists(), "Build the app before running the sidebar flow").toBe(true);
  const sessionId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const ctx = await launchSeededElectron({
    sessionId,
    sessionTitle: "Long conversation title ".repeat(30),
    historyRows: [{ role: "user", content: "Sidebar layout" }],
    settings: {
      ...buildLlmSettings(),
      system: {
        appMode: "work", sidebarWidth: 200,
        mainLayout: {
          version: 1, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", surfaces: {}, panelOpenIds: [],
          sideTabs: { main: [
            { tabId: "browser:abc12345-1", kind: "browser", ordinal: 1, url: null, cwd: null },
            { tabId: "terminal:abc12345-2", kind: "terminal", ordinal: 1, url: null, cwd: null },
          ] },
        },
      },
    },
  });
  try {
    const { page } = ctx;
    await expect(page.getByTestId("sidebar-sections")).toBeVisible();
    await expect(page.getByTestId("sidebar-card")).toHaveCSS("width", "200px");
    for (const width of [720, 900, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByTestId(`sidebar-session-${sessionId}`)).toBeVisible();
      await expect(page.getByTestId("sidebar-surface-browser:abc12345-1")).toBeVisible();
      await expect(page.getByTestId("sidebar-surface-terminal:abc12345-2")).toBeVisible();
      const metrics = await page.getByTestId("sidebar-sections").evaluate((sections) => {
        const card = sections.closest('[data-testid="sidebar-card"]')!;
        const bounds = card.getBoundingClientRect();
        return {
          cardWidth: bounds.width,
          labels: Array.from(sections.querySelectorAll("section")).map((section) => section.getAttribute("aria-label")),
          hasTabs: Boolean(sections.querySelector('[role="tablist"]')),
          overflow: sections.scrollWidth - sections.clientWidth,
          rowsWithinCard: Array.from(sections.querySelectorAll("button")).every((row) => row.getBoundingClientRect().right <= bounds.right + 1),
        };
      });
      expect(metrics.cardWidth).toBe(200);
      expect(metrics.labels).toEqual(["프로젝트", "일반"]);
      expect(metrics.hasTabs).toBe(false);
      expect(metrics.overflow).toBeLessThanOrEqual(1);
      expect(metrics.rowsWithinCard).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-${width}.png`) });
    }
    await page.getByTestId("sidebar-surface-terminal:abc12345-2").click();
    await expect(page.getByTestId("chat-side-panel-tab-strip")).toBeVisible();
    await expect(page.locator('[data-testid="chat-side-panel-tab-strip"] [data-tab-id="terminal:abc12345-2"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("sidebar-surface-browser:abc12345-1").click();
    await expect(page.getByTestId("chat-side-panel-browser-tab-host")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-browser-tab-host")).toHaveAttribute("data-tab-id", "browser:abc12345-1");
  } finally {
    await teardownSeededElectron(ctx);
  }
});
