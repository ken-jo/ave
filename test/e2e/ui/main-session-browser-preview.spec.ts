import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

// A static, never-revealed page must deliver its first picture through the real observation and screencast path.
test.use({ trace: "on" });
test("paints a parked main-session page while its panel stays closed", async () => {
  test.setTimeout(90_000);
  const model = "static-browser-preview-fixture";
  let stage = 0;
  let firstUrl = "";
  let secondUrl = "";
  let tabId = "";
  let releaseNavigation: (() => void) | undefined;
  let releaseFinish: (() => void) | undefined;
  const failures: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "static-preview", object: "chat.completion.chunk", created: 0,
      model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const tool = (response: ServerResponse, name: string, args: Record<string, unknown>) => {
    send(response, { role: "assistant", tool_calls: [{ index: 0, id: `static-preview-${stage}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null);
    send(response, {}, "tool_calls");
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] })); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/page")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><title>Static example</title></head><body style="font:20px system-ui;padding:40px;background:#fff8e0"><h1>${request.url.includes("second") ? "Example destination" : "Example source"}</h1><a href="${secondUrl}">Continue</a><p>A static page without animation.</p></body></html>`); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    const result = body.messages?.findLast(message => message.role === "tool")?.content;
    const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
    if (/"error"\s*:/.test(text)) failures.push(text);
    stage += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (stage === 1) { tool(response, "browser_navigate", { url: firstUrl }); return; }
    if (stage === 2) {
      tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(text)?.[1] ?? "";
      tool(response, "browser_snapshot", { tabId, interactive: true }); return;
    }
    if (stage === 3) {
      releaseNavigation = () => tool(response, "browser_navigate", { tabId, url: secondUrl });
      response.flushHeaders(); return;
    }
    if (stage === 4) { tool(response, "browser_snapshot", { tabId }); return; }
    releaseFinish = () => {
      send(response, { role: "assistant", content: "Static preview task complete." }, null);
      send(response, {}, "stop"); response.end("data: [DONE]\n\n");
    };
    response.flushHeaders();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Static preview fixture address unavailable");
  firstUrl = `http://127.0.0.1:${address.port}/page`;
  secondUrl = `http://localhost:${address.port}/page?second=1`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  let approving = true;
  let approvals: Promise<void> | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "Static browser preview", settings, historyRows: [], launchArgs: ["--use-mock-keychain"] });
    const { page } = ctx;
    const panelToggle = page.getByTestId(TEST_IDS.panePanelToggle);
    await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-static-preview");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const state = window as unknown as { previewCapture: unknown[] };
      state.previewCapture = [];
      window.ave.preview.onObservationPreview(message => state.previewCapture.push(message.kind === "frame" ? { ...message, data: "" } : message));
    });
    const composer = page.getByTestId("pane-cell:main").getByTestId("composer-textarea");
    await composer.fill("Read the static example source."); await composer.press("Enter");
    approvals = (async () => {
      while (approving) {
        const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
        if (await site.isVisible()) await site.click();
        const button = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
        if (await button.isVisible()) await button.click();
        await page.waitForTimeout(100);
      }
    })();
    await expect.poll(() => releaseNavigation !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    const preview = page.getByTestId("conversation-browser-observation").getByTestId("browser-observation-preview");
    await expect(preview).toBeVisible();
    try {
      await expect(preview.locator("img")).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => preview.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    } finally {
      const capture = await page.evaluate(() => (window as unknown as { previewCapture: unknown[] }).previewCapture);
      expect(capture).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "frame", tabId })]));
      console.log("Static parked preview messages", capture);
      await test.info().attach("static-preview-messages.json", { body: JSON.stringify(capture), contentType: "application/json" });
      const guests = await ctx.app.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().filter(contents => contents.getType() === "webview").map(async contents => ({ url: contents.getURL(), focused: contents.isFocused(), layout: await contents.executeJavaScript("({ visibility: document.visibilityState, width: innerWidth, height: innerHeight })") }))));
      console.log("Static parked guest layout", guests);
      await test.info().attach("static-preview-guests.json", { body: JSON.stringify(guests), contentType: "application/json" });
    }
    await test.info().attach("static-preview.png", { body: await page.screenshot(), contentType: "image/png" });
    await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
    const firstPicture = await preview.locator("img").getAttribute("src");
    releaseNavigation?.();
    await expect.poll(() => releaseFinish !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    await expect(preview.locator("img")).not.toHaveAttribute("src", firstPicture ?? "");
    await expect.poll(() => preview.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await test.info().attach("static-cross-site-preview.png", { body: await page.screenshot(), contentType: "image/png" });
    await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
    releaseFinish?.();
    await expect(page.getByTestId("chat-main-column").getByText("Static preview task complete.", { exact: true })).toBeVisible();
  } finally {
    approving = false;
    if (approvals) await approvals;
    if (ctx) await teardownSeededElectron(ctx, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
