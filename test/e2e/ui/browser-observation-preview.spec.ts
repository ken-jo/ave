import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import type { AgentObservationEvent, BrowserObservationPreviewMessage } from "../../../src/shared/agent-observation.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

type PreviewCapture = { previewMessages: (BrowserObservationPreviewMessage & { receivedAt: number })[]; observed: AgentObservationEvent[] };

test("streams a bounded live preview of the agent's tab and re-arms it across a cross-site commit", async () => {
  test.setTimeout(150_000);
  const model = "browser-preview-fixture";
  let stage = 0;
  let tabId = "";
  let clickRef = "";
  let releaseNavigation: (() => void) | undefined;
  let releaseFinish: (() => void) | undefined;
  let firstUrl = "";
  let secondUrl = "";
  const failures: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "browser-preview", object: "chat.completion.chunk", created: 0,
      model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const tool = (response: ServerResponse, name: string, args: Record<string, unknown>) => {
    send(response, { role: "assistant", tool_calls: [{ index: 0, id: `browser-preview-${stage}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] }, null);
    send(response, {}, "tool_calls");
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/page")) {
      const second = request.url.includes("second");
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><title>Preview fixture</title></head><body style="font:16px system-ui;padding:32px;background:${second ? "#e8f0ff" : "#fff8e0"}"><h1>${second ? "Second site" : "First site"}</h1><button onclick="document.querySelector('output').textContent='Clicked'">Continue</button><output>Ready</output><p id="tick">0</p><script>let n=0;setInterval(()=>{document.getElementById('tick').textContent=String(++n)},100)</script></body></html>`);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    const result = (body.messages ?? []).findLast((message) => message.role === "tool")?.content;
    const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
    if (/"error"\s*:/.test(text)) failures.push(text);
    stage += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (stage === 1) { tool(response, "browser_tab_new", { url: firstUrl }); return; }
    if (stage === 2) {
      tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(text)?.[1] ?? "";
      tool(response, "browser_tabs", { select: tabId }); return;
    }
    if (stage === 3) { tool(response, "browser_snapshot", { tabId, interactive: true }); return; }
    if (stage === 4) {
      clickRef = /button "Continue"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      tool(response, "browser_click", { tabId, ref: clickRef }); return;
    }
    if (stage === 5) {
      releaseNavigation = () => tool(response, "browser_navigate", { tabId, url: secondUrl });
      response.flushHeaders(); return;
    }
    if (stage === 6) {
      releaseFinish = () => {
        send(response, { role: "assistant", content: "Preview task complete." }, null);
        send(response, {}, "stop");
        response.end("data: [DONE]\n\n");
      };
      response.flushHeaders(); return;
    }
    send(response, { role: "assistant", content: "Preview task complete." }, null);
    send(response, {}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview fixture address unavailable");
  firstUrl = `http://127.0.0.1:${address.port}/page`;
  // A different site, so the commit can swap renderer processes and invalidate the screencast client.
  secondUrl = `http://localhost:${address.port}/page?second=1`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  let approving = true;
  let approvals: Promise<void> | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "Agent browser preview", settings, historyRows: [],
      launchArgs: ["--use-mock-keychain"] });
    const runtime = await ctx.app.evaluate(() => ({ aveHome: process.env.AVE_HOME, mockKeychain: process.argv.includes("--use-mock-keychain") }));
    expect(runtime.aveHome).toBe(ctx.aveHome);
    expect(runtime.mockKeychain).toBe(true);
    await ctx.app.evaluate(({ app }) => {
      const state = globalThis as unknown as { previewCrashes: unknown[] };
      state.previewCrashes = [];
      app.on("web-contents-created", (_event, contents) => {
        contents.on("render-process-gone", (_crash, details) => state.previewCrashes.push({ guestId: contents.id, ...details }));
      });
    });
    const page = ctx.page;
    const errors: string[] = [];
    page.on("crash", () => errors.push("Main renderer crashed"));
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-browser-preview");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const capture = window as unknown as PreviewCapture;
      capture.previewMessages = [];
      capture.observed = [];
      window.ave.preview.onAgentObservation((events) => capture.observed.push(...events));
      window.ave.preview.onObservationPreview((message) => {
        capture.previewMessages.push({ ...message, receivedAt: Date.now() });
        // Paint-complete acknowledgement, as the panel sends after decoding each frame.
        if (message.kind === "frame") void window.ave.preview.requestObservationPreview({ action: "rendered",
          targetId: message.targetId, sessionId: message.sessionId, tabId: message.tabId, frame: message.frame });
      });
    });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    const composer = page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    await composer.fill("Browse the local preview fixture.");
    await composer.press("Enter");
    approvals = (async () => {
      const deadline = Date.now() + 100_000;
      while (approving && Date.now() < deadline) {
        const button = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
        if (await button.isVisible()) await button.click();
        await page.waitForTimeout(100);
      }
    })();
    await expect.poll(() => releaseNavigation !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    const readCapture = () => page.evaluate(() => {
      const capture = window as unknown as PreviewCapture;
      return { messages: capture.previewMessages.map((message) => message.kind === "frame" ? { ...message, data: "" } : message),
        observed: capture.observed };
    });
    const click = (await readCapture()).observed.findLast((event) => event.source === "browser" && event.kind === "action"
      && event.after.action === "click");
    expect(click).toBeDefined();
    if (click?.source !== "browser" || click.kind !== "action") throw new Error("No agent click observation");
    const binding = { targetId: click.target.id, sessionId: click.sessionId, tabId: click.after.tabId };
    expect(binding.tabId).toBe(tabId);
    // Another tab handle is refused rather than substituted.
    expect(await page.evaluate((request) => window.ave.preview.requestObservationPreview(request),
      { action: "start" as const, ...binding, tabId: "tab-999", frame: 0 })).toEqual({ ok: false, error: "not-agent-tab" });
    expect(await page.evaluate((request) => window.ave.preview.requestObservationPreview(request),
      { action: "start" as const, ...binding, frame: 0 })).toEqual({ ok: true });
    await expect.poll(async () => (await readCapture()).messages.filter((message) => message.kind === "frame").length,
      { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    const firstFrames = await page.evaluate(() => (window as unknown as PreviewCapture).previewMessages.filter((message) => message.kind === "frame"));
    for (const frame of firstFrames) {
      if (frame.kind !== "frame") continue;
      expect(frame.mimeType).toBe("image/jpeg");
      expect(frame.data.length).toBeLessThanOrEqual(400_000);
      expect(Buffer.from(frame.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    }
    // At most four forwarded frames per second.
    const times = firstFrames.map((frame) => frame.receivedAt);
    for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(200);
    const lastFirst = firstFrames.at(-1)!;
    if (lastFirst.kind === "frame") {
      const imagePath = test.info().outputPath("agent-tab-preview-first-site.jpg");
      writeFileSync(imagePath, Buffer.from(lastFirst.data, "base64"));
      await test.info().attach("agent-tab-preview-first-site", { path: imagePath, contentType: "image/jpeg" });
    }

    const navigatedAt = Date.now();
    releaseNavigation!();
    await expect.poll(() => releaseFinish !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    const committedUrl = await ctx.app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .map((contents) => contents.getURL()).find((url) => url.includes("second=1")) ?? "");
    expect(committedUrl).toContain("localhost");
    // Frames keep arriving after the cross-site commit: the screencast was re-armed on the new document.
    await expect.poll(async () => (await page.evaluate((since) => (window as unknown as PreviewCapture).previewMessages
      .filter((message) => message.kind === "frame" && message.receivedAt > since + 500).length, navigatedAt)), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);
    const afterFrames = await page.evaluate((since) => (window as unknown as PreviewCapture).previewMessages
      .filter((message) => message.kind === "frame" && message.receivedAt > since + 500), navigatedAt);
    const lastAfter = afterFrames.at(-1)!;
    if (lastAfter.kind === "frame") {
      const imagePath = test.info().outputPath("agent-tab-preview-second-site.jpg");
      writeFileSync(imagePath, Buffer.from(lastAfter.data, "base64"));
      await test.info().attach("agent-tab-preview-second-site", { path: imagePath, contentType: "image/jpeg" });
    }

    // A native user click in the same tab is a takeover: the preview stops and cannot restart while paused.
    const beforeTakeover = Date.now();
    await ctx.app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().includes("second=1"));
      if (!guest) throw new Error("Preview fixture guest unavailable");
      guest.focus();
      guest.sendInputEvent({ type: "mouseDown", x: 40, y: 200, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: 40, y: 200, button: "left", clickCount: 1 });
    });
    await expect.poll(async () => (await readCapture()).messages.some((message) => message.kind === "state"
      && message.state === "stopped" && message.receivedAt >= beforeTakeover), { timeout: 10_000 }).toBe(true);
    await expect(page.getByTestId("agent-browser-control-resume")).toBeVisible();
    const stoppedCount = (await readCapture()).messages.length;
    await page.waitForTimeout(1_500);
    expect((await readCapture()).messages.length).toBe(stoppedCount);
    expect(await page.evaluate((request) => window.ave.preview.requestObservationPreview(request),
      { action: "start" as const, ...binding, frame: 0 })).toEqual({ ok: false, error: "not-agent-tab" });

    releaseFinish!();
    await expect(page.getByTestId("chat-main-column").getByText("Preview task complete.", { exact: true })).toBeVisible({ timeout: 60_000 });
    approving = false;
    await approvals;
    // Preview frames never entered the observation stream.
    const observed = (await readCapture()).observed;
    expect(JSON.stringify(observed)).not.toContain("image/jpeg");
    expect(observed.every((event) => event.source === "browser" && event.actor === "agent")).toBe(true);
    expect(errors).toEqual([]);
    expect(await ctx.app.evaluate(() => (globalThis as unknown as { previewCrashes: unknown[] }).previewCrashes)).toEqual([]);
  } finally {
    approving = false;
    try { if (approvals) await approvals; }
    finally {
      try { if (ctx) await teardownSeededElectron(ctx, { terminate: true }); }
      finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  }
});
