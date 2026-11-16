import assert from "node:assert/strict";
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

test("sidebar overlay and rail tooltip stay above an embedded page", async ({ browserName: _browserName }, testInfo) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Sidebar layering</title>
      <style>html,body{margin:0;height:100%;background:rgb(180,0,200)}</style>
      <script>window.pagePresses=0;addEventListener('pointerdown',()=>pagePresses++);</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  let context: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    context = await launchSeededElectron({ historyRows: [], settings: { ...buildLlmSettings(), system: { sidebarState: "rail" } } });
    const { app, page } = context;
    await setWindowSize(app, 600, 800);
    await page.getByTestId("sidebar-web").click();
    await page.getByTestId("web-panel-address").fill(url);
    await page.getByTestId("web-panel-address").press("Enter");
    const guest = page.getByTestId("chat-side-panel-browser-webview");
    await expect(guest).toBeVisible();
    const guestId = await guest.evaluate(element => (element as unknown as { getWebContentsId(): number }).getWebContentsId());
    const pagePresses = () => app.evaluate(async ({ webContents }, id) => {
      const target = webContents.fromId(id);
      if (!target) throw new Error("Embedded page unavailable");
      return target.executeJavaScript("window.pagePresses");
    }, guestId);
    await expect.poll(pagePresses).toBe(0);

    const railButton = page.getByTestId("sidebar-terminal");
    const label = await railButton.getAttribute("aria-label");
    assert(label);
    await railButton.hover();
    const tooltip = page.getByRole("tooltip", { name: label, exact: true });
    await expect(tooltip).toBeVisible();
    const tooltipHit = await tooltip.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const target = document.elementFromPoint(point.x, point.y);
      const page = document.querySelector('[data-testid="chat-side-panel-browser-webview"]')?.getBoundingClientRect();
      return { point, hit: target !== null && element.contains(target),
        overlaps: Boolean(page && point.x >= page.left && point.x < page.right && point.y >= page.top && point.y < page.bottom) };
    });
    expect(tooltipHit.overlaps).toBe(true);
    expect(tooltipHit.hit).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("rail-tooltip-over-page.png") });
    await page.keyboard.press("Escape");
    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(page.getByTestId("primary-sidebar")).toHaveAttribute("data-sidebar-overlay", "true");
    const action = page.getByTestId("sidebar-card-memory");
    await expect(action).toBeVisible();
    const geometry = await action.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const view = document.querySelector('[data-testid="chat-side-panel-browser-webview"]');
      if (!view) throw new Error("Embedded page unavailable");
      const page = view.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const target = document.elementFromPoint(point.x, point.y);
      return { action: rect.toJSON(), page: page.toJSON(), point,
        overlaps: point.x >= page.left && point.x < page.right && point.y >= page.top && point.y < page.bottom,
        hit: target !== null && element.contains(target) };
    });
    await testInfo.attach("sidebar-page-hit-geometry", { body: JSON.stringify({ tooltipHit, ...geometry }, null, 2), contentType: "application/json" });
    expect(geometry.overlaps).toBe(true);
    expect(geometry.hit).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("sidebar-overlay-over-page.png") });
    await action.click();
    await expect(page.getByTestId("memory-search-panel")).toBeVisible();
    expect(await pagePresses()).toBe(0);
  } finally {
    if (context) await teardownSeededElectron(context, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
