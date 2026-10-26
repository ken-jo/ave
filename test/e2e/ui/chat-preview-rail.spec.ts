import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import {
  buildLlmSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

type JsonObject = Record<string, unknown>;

const READ_PATH = "C:\\workspace\\ave\\src\\notes.md";
const WRITE_PATH = "C:\\workspace\\ave\\src\\report.md";

function buildPreviewRows(sideBrowserUrl = "https://example.com/docs"): JsonObject[] {
  const now = Date.now() - 10_000;
  return [
    {
      role: "user",
      content: "Show me the artifacts from this run.",
      createdAt: now,
    },
    {
      role: "assistant",
      content: "",
      thought: "Collecting files, HTML, JSON, and links for preview.",
      toolCalls: [
        {
          id: "preview-read",
          name: "read_file",
          input: { path: READ_PATH },
        },
        {
          id: "preview-write",
          name: "write_file",
          input: {
            path: WRITE_PATH,
            oldText: "export const value = 1;\n",
            newText: "export const value = 2;\n",
          },
        },
        {
          id: "preview-html",
          name: "render_html",
          input: {},
        },
        {
          id: "preview-web",
          name: "web_fetch",
          category: "network",
          input: { url: sideBrowserUrl },
        },
        {
          id: "preview-search",
          name: "web_search",
          category: "network",
          input: { q: "ave side panel" },
        },
        {
          id: "preview-plugin",
          name: "meeting_lookup",
          source: "plugin",
          pluginId: "meeting",
          input: { query: "standup" },
        },
      ],
      createdAt: now + 100,
    },
    {
      role: "tool_result",
      toolUseId: "preview-read",
      toolName: "read_file",
      content: "# Notes\nPreview source file contents.",
      createdAt: now + 200,
    },
    {
      role: "tool_result",
      toolUseId: "preview-write",
      toolName: "write_file",
      content: JSON.stringify({
        kind: "ave.write_file",
        path: WRITE_PATH,
        before: "export const value = 1;\n",
        after: "export const value = 2;\n",
      }),
      createdAt: now + 300,
    },
    {
      role: "tool_result",
      toolUseId: "preview-html",
      toolName: "render_html",
      content: JSON.stringify({
        kind: "ave.render_html",
        title: "Artifact dashboard",
        html: "<section><h1>Preview OK</h1><p>Side rail smoke.</p></section>",
        height: 220,
      }),
      createdAt: now + 400,
    },
    {
      role: "tool_result",
      toolUseId: "preview-web",
      toolName: "web_fetch",
      content: JSON.stringify({ status: 200, title: "Example docs", ok: true, url: sideBrowserUrl }),
      createdAt: now + 500,
    },
    {
      role: "tool_result",
      toolUseId: "preview-search",
      toolName: "web_search",
      content: `Search result: https://search.example.test/ave-side-panel and ${sideBrowserUrl}`,
      createdAt: now + 550,
    },
    {
      role: "tool_result",
      toolUseId: "preview-plugin",
      toolName: "meeting_lookup",
      content: JSON.stringify({ ok: true, title: "Standup" }),
      createdAt: now + 575,
    },
    {
      role: "assistant",
      content: "Artifacts are ready for review.",
      createdAt: now + 600,
    },
  ];
}

async function createSideBrowserTarget(): Promise<{ url: string; close: () => Promise<void> }> {
  const externalUrl = process.env.AVE_SIDE_BROWSER_TEST_URL;
  if (externalUrl) {
    const parsed = new URL(externalUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`AVE_SIDE_BROWSER_TEST_URL must be http(s): ${externalUrl}`);
    }
    return { url: parsed.toString(), close: async () => {} };
  }

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><main><h1>Side Browser OK</h1></main></body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("failed to allocate side browser server port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/docs`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function captureSideBrowserGuest(ctx: SeededElectronContext, expectedUrl: string) {
  return ctx.app.evaluate(async ({ webContents }, url) => {
    const expected = new URL(url);
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getType() === "webview");
    const guest = candidates.find((contents) => {
      try {
        const current = new URL(contents.getURL());
        return current.href === expected.href || current.host === expected.host;
      } catch {
        return false;
      }
    });
    if (!guest) return null;
    await guest.executeJavaScript("document.readyState", true).catch(() => undefined);
    const text = await guest.executeJavaScript(
      "document.body ? document.body.innerText.slice(0, 1200) : ''",
      true,
    ).catch((err: unknown) => `executeJavaScript failed: ${err instanceof Error ? err.message : String(err)}`);
    const image = await guest.capturePage();
    return {
      url: guest.getURL(),
      title: guest.getTitle(),
      text,
      pngBase64: image.toPNG().toString("base64"),
    };
  }, expectedUrl);
}

async function waitForSideBrowserGuestCapture(ctx: SeededElectronContext, expectedUrl: string) {
  const deadline = Date.now() + 20_000;
  let lastProbe: Awaited<ReturnType<typeof captureSideBrowserGuest>> = null;
  while (Date.now() < deadline) {
    lastProbe = await captureSideBrowserGuest(ctx, expectedUrl);
    if (lastProbe && lastProbe.pngBase64.length > 1_000) return lastProbe;
    await ctx.page.waitForTimeout(500);
  }
  throw new Error(`side browser guest capture did not become ready: ${JSON.stringify(lastProbe)}`);
}

async function readCdpProbe(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await cdp.detach();
  return {
    metrics: Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value])),
    screenshot,
  };
}

test.describe("chat preview rail", () => {
  test.skip(!builtMainExists(), "dist/src/main/main.js not built; run bun run build first");

  test("opens a side-by-side artifact rail and workspace file browser under CDP", async () => {
    const sideBrowser = await createSideBrowserTarget();
    let ctx: SeededElectronContext | null = null;
    try {
      ctx = await launchSeededElectron({
        settings: buildLlmSettings("openai", "gpt-5.4-mini"),
        sessionTitle: "preview rail e2e",
        historyRows: buildPreviewRows(sideBrowser.url),
        userDataPrefix: "ave-preview-rail-user-data-",
        homePrefix: "ave-preview-rail-home-",
      });
      const sideBrowserHost = new URL(sideBrowser.url).host;
      const sideBrowserOrigin = new URL(sideBrowser.url).origin;
      await ctx.page.setViewportSize({ width: 1280, height: 860 });
      await ctx.page.waitForFunction(
        () => typeof (window as unknown as { __aveChatStream?: { _emit?: unknown } })
          .__aveChatStream?._emit === "function",
        undefined,
        { timeout: 20_000 },
      );

      const openButton = ctx.page.getByTestId(TEST_IDS.panePanelToggle);
      await expect(openButton).toBeVisible({ timeout: 20_000 });
      await expect(ctx.page.getByTestId("chat-preview-rail")).toHaveCount(0);
      await expect(ctx.page.getByTestId("pane-header")).not.toContainText("도구 활동");
      // Work-panel controls belong to the pane header below the window band.
      const toolbarBox = await ctx.page.getByTestId("main-toolbar").boundingBox();
      const paneHeader = ctx.page.getByTestId("pane-header");
      const paneHeaderBox = await paneHeader.boundingBox();
      const sidePanelButtonBox = await openButton.boundingBox();
      const paneHeaderPaddingRight = await paneHeader.evaluate((element: Element) => Number.parseFloat(getComputedStyle(element).paddingRight));
      expect(toolbarBox).not.toBeNull();
      expect(paneHeaderBox).not.toBeNull();
      expect(sidePanelButtonBox).not.toBeNull();
      expect(sidePanelButtonBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height);
      expect(sidePanelButtonBox!.y).toBeGreaterThanOrEqual(paneHeaderBox!.y);
      expect(sidePanelButtonBox!.y + sidePanelButtonBox!.height).toBeLessThanOrEqual(paneHeaderBox!.y + paneHeaderBox!.height);
      expect(Math.abs((paneHeaderBox!.x + paneHeaderBox!.width - paneHeaderPaddingRight) - (sidePanelButtonBox!.x + sidePanelButtonBox!.width))).toBeLessThanOrEqual(1);

      await openButton.click();
      const panel = ctx.page.getByTestId(TEST_IDS.chatSidePanel);
      const rail = ctx.page.getByTestId("chat-preview-rail");
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(rail).toBeVisible({ timeout: 10_000 });
      await expect(ctx.page.getByTestId("chat-side-panel-launcher")).toBeVisible();
      await ctx.page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
      await expect(ctx.page.getByTestId("chat-side-panel-tab-file-browser")).toBeVisible();
      // Session artifacts require the Session files source rather than the default Directory source.
      await ctx.page.getByTestId("chat-side-panel-file-source-session").click();
      await expect(rail).toContainText("report.md");
      await expect(ctx.page.getByTestId("chat-side-panel-file-tree")).toBeVisible();
      await expect(ctx.page.getByTestId("chat-side-panel-file-splitter")).toBeVisible();
      const splitLayout = ctx.page.getByTestId("chat-side-panel-file-split-layout");
      const splitter = ctx.page.getByTestId("chat-side-panel-file-splitter");
      const splitBeforeDrag = await splitLayout.evaluate((element) => (element as HTMLElement).style.gridTemplateRows);
      const splitterBox = await splitter.boundingBox();
      expect(splitterBox).not.toBeNull();
      await ctx.page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + splitterBox!.height / 2);
      await ctx.page.mouse.down();
      await ctx.page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + 80, { steps: 4 });
      await ctx.page.mouse.up();
      await expect.poll(async () => splitLayout.evaluate((element) => (element as HTMLElement).style.gridTemplateRows)).not.toBe(splitBeforeDrag);

      const tabCountBefore = await ctx.page.getByRole("tab").count();
      const addTabTrigger = ctx.page.getByTestId("chat-side-panel-add-tab");
      await addTabTrigger.dispatchEvent("pointerdown");
      await ctx.page.getByTestId(chatSidePanelLauncherTestId("menu-browser")).click();
      await expect(ctx.page.getByRole("tab")).toHaveCount(tabCountBefore + 1);
      await expect(ctx.page.getByTestId("chat-side-panel-tab-browser")).toBeVisible();
      await expect(ctx.page.getByTestId("chat-side-panel-tab-actions")).toBeVisible();
      // A browser tab uses the latest transcript URL; visited sites belong to the empty landing panel.
      await expect(ctx.page.getByTestId("chat-side-panel-browser-visited")).toHaveCount(0);
      await expect(ctx.page.getByTestId("chat-side-panel-browser-address")).toHaveValue("https://search.example.test/ave-side-panel");
      await expect(ctx.page.getByTestId("chat-side-panel-browser-webview")).toBeVisible();
      const browserProbe = await readCdpProbe(ctx.page);
      await test.info().attach("chat-side-panel-browser-cdp.png", {
        contentType: "image/png",
        body: Buffer.from(browserProbe.screenshot.data, "base64"),
      });
      expect(browserProbe.screenshot.data.length).toBeGreaterThan(20_000);

      await ctx.page.getByTestId("chat-side-panel-browser-address").fill(sideBrowser.url);
      await ctx.page.getByTestId("chat-side-panel-browser-go").click();
      const directBrowserWebview = ctx.page.getByTestId("chat-side-panel-browser-webview");
      await expect(directBrowserWebview).toBeVisible();
      await expect(directBrowserWebview).toHaveAttribute("src", sideBrowser.url);

      // Keep this spec docked; the workspace-rail spec covers narrow overlays.
      const browserWebview = ctx.page.getByTestId("chat-side-panel-browser-webview");
      await expect(browserWebview).toBeVisible();
      await expect(browserWebview).toHaveAttribute("src", sideBrowser.url);
      await expect(browserWebview).toHaveAttribute("partition", "persist:ave-side-browser");
      await expect(browserWebview).toHaveAttribute("webpreferences", /javascript=yes/);
      await ctx.page.waitForFunction((expectedUrl) => {
        const view = document.querySelector('[data-testid="chat-side-panel-browser-webview"]') as
          | (HTMLElement & { getURL?: () => string })
          | null;
        return Boolean(view && (view.getURL?.() === expectedUrl || view.getAttribute("src") === expectedUrl));
      }, sideBrowser.url);
      const urlProbe = await readCdpProbe(ctx.page);
      await test.info().attach("chat-side-panel-url-webview-cdp.png", {
        contentType: "image/png",
        body: Buffer.from(urlProbe.screenshot.data, "base64"),
      });
      expect(urlProbe.screenshot.data.length).toBeGreaterThan(20_000);
      const capturedGuest = await waitForSideBrowserGuestCapture(ctx, sideBrowser.url);
      expect(new URL(capturedGuest.url).host).toBe(sideBrowserHost);
      expect(`${capturedGuest.title}\n${capturedGuest.text}`.trim().length).toBeGreaterThan(0);
      const expectedSideBrowserHostname = new URL(sideBrowser.url).hostname;
      if (expectedSideBrowserHostname === "www.google.com" || expectedSideBrowserHostname === "google.com") {
        expect(`${capturedGuest.title}\n${capturedGuest.text}`).toMatch(/Google|Search/i);
      }
      await test.info().attach("chat-side-panel-url-guest-webview.txt", {
        contentType: "text/plain",
        body: Buffer.from(`${capturedGuest.url}\n${capturedGuest.title}\n\n${capturedGuest.text}`),
      });
      await test.info().attach("chat-side-panel-url-guest-webview.png", {
        contentType: "image/png",
        body: Buffer.from(capturedGuest.pngBase64, "base64"),
      });

      // The preview launcher excludes targets already covered by browser and file surfaces.
      const addPreviewTrigger = ctx.page.getByTestId("chat-side-panel-add-tab");
      await addPreviewTrigger.dispatchEvent("pointerdown");
      await ctx.page.getByTestId(chatSidePanelLauncherTestId("menu-preview")).click();
      await expect(ctx.page.getByTestId("chat-side-panel-tab-preview")).toBeVisible();
      await expect(rail).not.toContainText("Artifact dashboard");
      await expect(rail).not.toContainText(sideBrowserHost);

      const chatBox = await ctx.page.locator(".ave-chat-scroll").boundingBox();
      const paneBox = await ctx.page.getByTestId("pane").boundingBox();
      const finalHeaderBox = await paneHeader.boundingBox();
      const mainColumnBox = await ctx.page.getByTestId("chat-main-column").boundingBox();
      const actionBarBox = await ctx.page.getByTestId("input-action-bar").boundingBox();
      const railBox = await panel.boundingBox();
      const finalSplitterBox = await ctx.page.getByTestId("chat-side-panel-width-splitter").boundingBox();
      // Include card insets when measuring transcript displacement and alignment with the sidebar.
      const { inset, insetBottom } = await ctx.page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          inset: Number.parseFloat(style.getPropertyValue("--shell-card-inset")),
          insetBottom: Number.parseFloat(style.getPropertyValue("--shell-card-inset-bottom")),
        };
      });
      expect(chatBox).not.toBeNull();
      expect(paneBox).not.toBeNull();
      expect(finalHeaderBox).not.toBeNull();
      expect(mainColumnBox).not.toBeNull();
      expect(actionBarBox).not.toBeNull();
      expect(railBox).not.toBeNull();
      expect(finalSplitterBox).not.toBeNull();
      expect(inset).toBeGreaterThan(0);
      expect(insetBottom).toBeGreaterThan(0);
      expect(railBox!.width).toBeGreaterThanOrEqual(300);
      expect(Math.abs(railBox!.x - (mainColumnBox!.x + mainColumnBox!.width) - inset)).toBeLessThanOrEqual(1);
      expect(railBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width - 2);
      expect(railBox!.x).toBeGreaterThan(actionBarBox!.x + actionBarBox!.width - 8);
      expect(finalSplitterBox!.width).toBeGreaterThanOrEqual(7);
      expect(finalSplitterBox!.width).toBeLessThanOrEqual(9);
      expect(Math.abs(finalSplitterBox!.x - railBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((paneBox!.x + paneBox!.width) - (railBox!.x + railBox!.width) - inset)).toBeLessThanOrEqual(2);
      expect(Math.abs(railBox!.y - finalHeaderBox!.y - inset)).toBeLessThanOrEqual(1);
      expect(Math.abs((paneBox!.y + paneBox!.height) - (railBox!.y + railBox!.height) - insetBottom)).toBeLessThanOrEqual(2);
      expect(Math.abs(chatBox!.width - mainColumnBox!.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(actionBarBox!.width - mainColumnBox!.width)).toBeLessThanOrEqual(48);
      await expect(panel).not.toHaveCSS("position", "absolute");

      await addTabTrigger.dispatchEvent("pointerdown");
      await ctx.page.getByTestId(chatSidePanelLauncherTestId("menu-activity")).click();
      const activityWorkspace = ctx.page.getByTestId("chat-side-panel-activity-workspace");
      await expect(activityWorkspace).toBeVisible();
      await expect(activityWorkspace.getByTestId("chat-side-panel-activity-plugins")).toContainText("meeting_lookup");
      await expect(activityWorkspace.getByTestId("chat-side-panel-activity-plugins")).toContainText("meeting");
      await expect(activityWorkspace.getByTestId("chat-side-panel-activity-tools")).toContainText("web_fetch");
      await expect(activityWorkspace.getByTestId("chat-side-panel-activity-tools")).toContainText(sideBrowserOrigin);
      await expect(activityWorkspace.getByTestId("chat-side-panel-activity-tools")).toContainText(READ_PATH);
      await expect(activityWorkspace.getByTestId("chat-side-panel-activity-tools")).toContainText(WRITE_PATH);
      const activityProbe = await readCdpProbe(ctx.page);
      await test.info().attach("activity-tab-cdp.png", {
        contentType: "image/png",
        body: Buffer.from(activityProbe.screenshot.data, "base64"),
      });

      await ctx.page.getByTestId("chat-side-panel-tab-file-browser").click();
      await ctx.page.getByTestId("chat-side-panel-file-source-changed").click();
      const changedRows = rail.getByTestId("chat-side-panel-file-change-row");
      await expect(changedRows).toHaveCount(1);
      await expect(changedRows.first()).toContainText("report.md");
      await expect(rail.getByTestId("chat-side-panel-file-change-operation")).toHaveText("씀");

      // Remounting resets the file source to Directory; reselect Session files.
      await ctx.page.getByTestId("chat-side-panel-tab-file-browser").click();
      await ctx.page.getByTestId("chat-side-panel-file-source-session").click();
      await expect(rail).toContainText("notes.md");
      await expect(rail).toContainText("report.md");
      await ctx.page.getByTestId("chat-preview-search").fill("report");
      const filteredFileRows = rail.getByTestId("chat-side-panel-file-tree-file");
      await expect(filteredFileRows).toHaveCount(1);
      await expect(filteredFileRows.first()).toContainText("report.md");
      await expect(filteredFileRows.first()).not.toContainText("notes.md");

      const { metrics, screenshot } = await readCdpProbe(ctx.page);
      await test.info().attach("chat-preview-rail-cdp-metrics.json", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(metrics, null, 2)),
      });
      await test.info().attach("chat-preview-rail-cdp.png", {
        contentType: "image/png",
        body: Buffer.from(screenshot.data, "base64"),
      });
      expect(typeof metrics.TaskDuration).toBe("number");
      expect(screenshot.data.length).toBeGreaterThan(20_000);
    } finally {
      try {
        if (ctx) await teardownSeededElectron(ctx);
      } finally {
        await sideBrowser.close();
      }
    }
  });
});
