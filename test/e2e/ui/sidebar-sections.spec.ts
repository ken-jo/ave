import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { BROWSER_FAVICON_DATA_URL } from "../../../src/__tests__/support/browser-control-fixture.js";
import { setWindowSize, buildLlmSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

// A real renderer measures truncation; the component tests cover assignment and actions.
test("keeps stacked sections and mixed rows inside a narrow sidebar", async ({}, testInfo) => {
  expect(builtMainExists(), "Build the app before running the sidebar flow").toBe(true);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<html><head><title>Sidebar icon</title><link rel="icon" type="image/png" href="${BROWSER_FAVICON_DATA_URL}"></head><body>Browser surface</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  const url = `http://127.0.0.1:${address.port}/`;
  const sessionId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const ctx = await launchSeededElectron({
    sessionId,
    sessionTitle: "Long conversation title ".repeat(30),
    historyRows: [{ role: "user", content: "Sidebar layout" }],
    settings: {
      ...buildLlmSettings(),
      system: {
        sidebarWidth: 200,
        mainLayout: {
          version: 2, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", surfaces: {}, openSurfaces: [], panelOpenIds: [],
          sideTabs: { main: [
            { tabId: "browser:abc12345-1", kind: "browser", ordinal: 1, url, cwd: null },
            { tabId: "terminal:abc12345-2", kind: "terminal", ordinal: 1, url: null, cwd: null },
          ] },
        },
      },
    },
  }).catch((error: unknown) => { server.close(); throw error; });
  try {
    const { page } = ctx;
    await expect(page.getByTestId("sidebar-sections")).toBeVisible();
    await expect(page.getByTestId("sidebar-card")).toHaveCSS("width", "200px");
    for (const width of [720, 900, 1100]) {
      await setWindowSize(ctx.app, width, 800);
      await expect(page.getByTestId(`sidebar-session-${sessionId}`)).toBeVisible();
      await expect(page.getByTestId("sidebar-surface-browser:abc12345-1")).toBeVisible();
      await expect(page.getByTestId("sidebar-surface-terminal:abc12345-2")).toBeVisible();
      const metrics = await page.getByTestId("sidebar-sections").evaluate((sections) => {
        const card = sections.closest('[data-testid="sidebar-card"]')!;
        const bounds = card.getBoundingClientRect();
        return {
          cardWidth: bounds.width,
          trees: sections.querySelectorAll('[role="tree"]').length,
          sectionCount: sections.querySelectorAll("section").length,
          hasTabs: Boolean(sections.querySelector('[role="tablist"]')),
          overflow: sections.scrollWidth - sections.clientWidth,
          rowsWithinCard: Array.from(sections.querySelectorAll('[role="treeitem"], button')).every((row) => row.getBoundingClientRect().right <= bounds.right + 1),
        };
      });
      expect(metrics.cardWidth).toBe(200);
      // Conversations, terminals and pages share one project tree (64ed41100) instead of labelled sections.
      expect(metrics.trees).toBe(1);
      expect(metrics.sectionCount).toBe(0);
      expect(metrics.hasTabs).toBe(false);
      expect(metrics.overflow).toBeLessThanOrEqual(1);
      expect(metrics.rowsWithinCard).toBe(true);
      const browserRow = page.getByTestId("sidebar-surface-browser:abc12345-1");
      // The tree has a roving tabindex: arrow keys move between rows and Enter opens the focused one.
      const browserItem = page.getByTestId("sidebar-surface-tree-browser:abc12345-1");
      const terminalItem = page.getByTestId("sidebar-surface-tree-terminal:abc12345-2");
      // Rows run newest use first. Each pass starts with the browser on top: the seed opens it last, and so does every pass.
      const rowOrder = () => page.getByTestId("sidebar-tree").evaluate((tree) =>
        Array.from(tree.querySelectorAll('[role="treeitem"]'))
          .map((item) => item.getAttribute("data-testid"))
          .filter((id) => id?.startsWith("sidebar-surface-tree-")));
      await expect.poll(rowOrder).toEqual([
        "sidebar-surface-tree-browser:abc12345-1", "sidebar-surface-tree-terminal:abc12345-2",
      ]);
      await browserItem.focus();
      await page.keyboard.press("ArrowDown");
      await expect(terminalItem).toBeFocused();
      await page.keyboard.press("Enter");
      // Opening the terminal moves it to the top, so the browser is now the row below it.
      await expect.poll(rowOrder).toEqual([
        "sidebar-surface-tree-terminal:abc12345-2", "sidebar-surface-tree-browser:abc12345-1",
      ]);
      await terminalItem.focus();
      await page.keyboard.press("ArrowDown");
      await expect(browserItem).toBeFocused();
      // Space opens the focused row as Enter does.
      await page.keyboard.press("Space");
      await expect(page.getByTestId("chat-side-panel-motion")).toHaveAttribute("data-panel-mode", width === 1100 ? "docked" : "overlay");
      await expect(page.getByTestId("chat-side-panel-browser-webview")).toBeVisible();
      await expect(browserRow).toHaveAttribute("aria-current", "page");
      await page.screenshot({ path: testInfo.outputPath(`sidebar-${width}.png`) });
      await page.getByTestId("sidebar-settings").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("sidebar-settings")).toHaveAttribute("aria-current", "page");
      await expect(browserRow).not.toHaveAttribute("aria-current");
      await browserRow.focus();
      await page.keyboard.press("Enter");
    }
    await page.getByTestId("sidebar-surface-terminal:abc12345-2").click();
    await expect(page.getByTestId("chat-side-panel-tab-strip")).toBeVisible();
    await expect(page.locator('[data-testid="chat-side-panel-tab-strip"] [data-tab-id="terminal:abc12345-2"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("sidebar-surface-browser:abc12345-1").click();
    await expect(page.locator('[data-testid="chat-side-panel-tab-strip"] [data-tab-id="browser:abc12345-1"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("chat-side-panel-browser-webview")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-browser-webview")).toHaveAttribute("src", url);
    const icon = page.getByTestId("sidebar-surface-browser:abc12345-1").locator("img");
    await expect(icon).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect.poll(() => icon.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(policy).toContain("img-src 'self' data: blob: ave-content:");
    await page.screenshot({ path: testInfo.outputPath("sidebar-favicon.png") });
    // The rail's web launcher opens a new page in the selected project.
    await page.getByTestId("sidebar-web").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("web-panel")).toBeVisible();
    await page.getByTestId("sidebar-surface-browser:abc12345-1").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("web-panel")).toBeHidden();
    await expect(page.getByTestId("chat-side-panel-browser-webview")).toBeVisible();
    await expect(page.getByTestId("sidebar-surface-browser:abc12345-1")).toHaveAttribute("aria-current", "page");
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
