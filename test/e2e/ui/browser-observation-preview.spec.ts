import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import type { AgentObservationEvent, BrowserObservationPreviewMessage } from "../../../src/shared/agent-observation.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron, setWindowSize } from "./seeded-electron.js";

test.use({ trace: "on" });

type PreviewCapture = { previewMessages: (BrowserObservationPreviewMessage & { receivedAt: number })[]; observed: AgentObservationEvent[] };

test("keeps a parked agent guest visible to its animation clock", () => exercisePreview("parked"));
test("selects in a parked guest without taking native keyboard focus", () => exercisePreview("focus"));
test("measures renderer evaluation after an agent closes its parked guest", () => exercisePreview("closure"));
test("streams a bounded live preview of the agent's tab and re-arms it across a cross-site commit", () => exercisePreview("navigation"));

async function exercisePreview(scope: "parked" | "focus" | "closure" | "navigation"): Promise<void> {
  test.setTimeout(scope === "closure" ? 30_000 : 150_000);
  const model = "browser-preview-fixture";
  let stage = 0;
  let tabId = "";
  let clickRef = "";
  let selectRef = "";
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
      response.end(`<!doctype html><html><head><title>Preview fixture</title></head><body style="font:16px system-ui;padding:32px;background:${second ? "#e8f0ff" : "#fff8e0"}"><h1>${second ? "Second site" : "First site"}</h1><button onclick="document.querySelector('output').textContent='Clicked'">Continue</button><output>Ready</output><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select><p id="tick">0</p><script>let n=0;setInterval(()=>{document.getElementById('tick').textContent=String(++n)},100)</script></body></html>`);
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
      selectRef = /combobox "Choice"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      tool(response, "browser_click", { tabId, ref: clickRef }); return;
    }
    if (stage === 5) {
      releaseNavigation = () => scope === "closure"
        ? tool(response, "browser_tab_close", { tabId })
        : scope === "focus" ? tool(response, "browser_select", { tabId, ref: selectRef, value: "b" })
        : tool(response, "browser_navigate", { tabId, url: secondUrl });
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
    if (scope === "closure") await ctx.app.evaluate(() => {
      process.on("uncaughtExceptionMonitor", (error) => console.error("Native close exception", error.stack));
    });
    await ctx.app.evaluate(({ app }) => {
      const state = globalThis as unknown as { previewCrashes: unknown[] };
      state.previewCrashes = [];
      app.on("web-contents-created", (_event, contents) => {
        contents.on("render-process-gone", (_crash, details) => state.previewCrashes.push({ guestId: contents.id, ...details }));
      });
    });
    const page = ctx.page;
    await setWindowSize(ctx.app, 1280, 800);
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
    const composer = page.getByTestId("pane-cell:main").getByTestId("composer-textarea");
    await composer.fill("Browse the local preview fixture.");
    await composer.press("Enter");
    approvals = (async () => {
      const deadline = Date.now() + 100_000;
      while (approving && Date.now() < deadline) {
        const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
        if (await site.isVisible()) await site.click();
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
    // Move the real side-panel tab to a main pane through the pane's existing drop path.
    const rendererTabId = click.after.rendererTabId;
    const chatPane = page.getByTestId("pane-cell:main").getByTestId("pane");
    await chatPane.evaluate((element, id) => {
      const rect = element.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-ave-surface", JSON.stringify({ tabId: id, kind: "browser", from: { side: "main" } }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer, clientX: rect.right - 2, clientY: rect.top + rect.height / 2 }));
    }, rendererTabId);
    const guestFrame = page.locator(`[data-testid="web-surface-frame"][data-tab-id="${rendererTabId}"]`);
    await expect(guestFrame).toHaveCSS("visibility", "visible");
    // Measure inside the real parked guest; a visible shell rect alone cannot prove its animation clock is running.
    const app = ctx.app;
    const measureLiveness = () => app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!guest) throw new Error("Parked preview guest unavailable");
      return await guest.executeJavaScript(`new Promise(resolve => {
        let frames = 0;
        let done = false;
        let frameId = 0;
        const started = performance.now();
        const tick = () => { if (!done) { frames += 1; frameId = requestAnimationFrame(tick); } };
        frameId = requestAnimationFrame(tick);
        setTimeout(() => {
          done = true;
          cancelAnimationFrame(frameId);
          resolve({ visibilityState: document.visibilityState, frames, elapsedMs: performance.now() - started,
            width: innerWidth, height: innerHeight });
        }, 750);
      })`) as { visibilityState: string; frames: number; elapsedMs: number; width: number; height: number };
    }, firstUrl);
    const activeLiveness = await measureLiveness();
    const hiddenAt = Date.now();
    await page.getByTestId("pane-cell:main").getByTestId("pane-maximize").click();
    const thumbnailRow = page.getByTestId("conversation-browser-observation");
    const thumbnail = thumbnailRow.getByRole("button");
    await expect(thumbnail).toBeVisible();
    await expect(thumbnailRow.getByTestId("browser-observation-slot")).toBeVisible();
    await expect(guestFrame).toHaveCSS("opacity", "0");
    await expect(guestFrame).toHaveCSS("pointer-events", "none");
    await expect(guestFrame).toHaveAttribute("aria-hidden", "true");
    await expect(guestFrame).toHaveAttribute("inert", "");
    expect(await guestFrame.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    expect(await page.locator(`webview[data-tab-id="${rendererTabId}"]`).count()).toBe(1);
    const liveness = await measureLiveness();
    console.log("Guest liveness", { active: activeLiveness, parked: liveness });
    await test.info().attach("parked-guest-liveness.json", { body: JSON.stringify({ active: activeLiveness, parked: liveness }, null, 2), contentType: "application/json" });
    expect(liveness.visibilityState).toBe("visible");
    expect(liveness.width).toBeGreaterThan(0);
    expect(liveness.height).toBeGreaterThan(0);
    expect(liveness.frames).toBeGreaterThanOrEqual(10);
    expect(liveness.frames / liveness.elapsedMs).toBeGreaterThanOrEqual(activeLiveness.frames / activeLiveness.elapsedMs / 2);
    if (scope === "parked") return;
    if (scope === "focus") {
      await ctx.app.evaluate(({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url);
        if (!guest) throw new Error("Parked focus guest unavailable");
        const state = globalThis as unknown as { parkedFocusEvents: number };
        state.parkedFocusEvents = 0;
        guest.on("focus", () => { state.parkedFocusEvents += 1; });
      }, firstUrl);
      releaseNavigation?.();
      await expect.poll(() => releaseFinish !== undefined, { timeout: 10_000 }).toBe(true);
      expect(failures).toEqual([]);
      const selected = await ctx.app.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url);
        if (!guest) throw new Error("Parked focus guest unavailable");
        return { focused: guest.isFocused(), focusEvents: (globalThis as unknown as { parkedFocusEvents: number }).parkedFocusEvents,
          value: await guest.executeJavaScript("document.querySelector('select').value") };
      }, firstUrl);
      expect(selected).toEqual({ focused: false, focusEvents: 0, value: "b" });
      await ctx.app.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url);
        if (!guest) throw new Error("Parked focus guest unavailable");
        await guest.executeJavaScript("window.parkedKeys = []; window.addEventListener('keydown', event => window.parkedKeys.push(event.key))");
        guest.focus();
        guest.sendInputEvent({ type: "keyDown", keyCode: "X" });
        guest.sendInputEvent({ type: "keyUp", keyCode: "X" });
      }, firstUrl);
      await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents()
        .find(contents => contents.getURL() === url)?.isFocused(), firstUrl)).toBe(false);
      const keys = await app.evaluate(async ({ webContents }, url) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url);
        if (!guest) throw new Error("Parked focus guest unavailable");
        return await guest.executeJavaScript("window.parkedKeys");
      }, firstUrl);
      expect(keys).toEqual([]);
      await composer.click();
      await page.keyboard.type("VISIBLE");
      await expect(composer).toHaveValue("VISIBLE");
      releaseFinish?.();
      await test.info().attach("parked-focus.json", { body: JSON.stringify(selected), contentType: "application/json" });
      return;
    }
    if (scope === "closure") {
      const closedAt = Date.now();
      releaseNavigation?.();
      await expect.poll(() => releaseFinish !== undefined, { timeout: 10_000 }).toBe(true);
      expect(failures).toEqual([]);
      await expect(guestFrame).toHaveCount(0);
      releaseFinish?.();
      await expect(page.getByText("Preview task complete.", { exact: true })).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      const evaluationMs: number[] = [];
      try {
        for (let index = 0; index < 5; index += 1) {
          const started = performance.now();
          const result = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
          evaluationMs.push(performance.now() - started);
          expect(result.result.value).toBe("complete");
          await page.waitForTimeout(100);
        }
      } finally {
        await cdp.detach();
      }
      const measurement = { evaluationMs,
        previewCount: await page.getByTestId("browser-observation-preview").count(),
        framesAfterClose: (await readCapture()).messages.filter((message) => message.kind === "frame" && message.receivedAt > closedAt + 100).length };
      console.log("Renderer after agent tab close", measurement);
      await test.info().attach("renderer-after-close.json", { body: JSON.stringify(measurement, null, 2), contentType: "application/json" });
      return;
    }
    const decoded: { src: string; ts: number }[] = [];
    const deadline = Date.now() + 3_200;
    while (Date.now() < deadline) {
      const src = await thumbnail.locator("img").evaluateAll((images) => {
        const image = images[0] as HTMLImageElement | undefined;
        return image?.complete && image.naturalWidth > 0 ? image.src : "";
      });
      if (src && decoded.at(-1)?.src !== src) decoded.push({ src, ts: Date.now() });
      await page.waitForTimeout(100);
    }
    console.log("Hidden conversation thumbnail decoded frames", { count: decoded.length, timestamps: decoded.map((frame) => frame.ts) });
    expect(new Set(decoded.map((frame) => frame.src)).size).toBeGreaterThanOrEqual(3);
    const hiddenFrames = (await readCapture()).messages.filter((message) => message.kind === "frame" && message.receivedAt >= hiddenAt);
    expect(hiddenFrames.length).toBeGreaterThanOrEqual(3);
    for (const frame of hiddenFrames) expect(frame).toMatchObject(binding);
    await page.screenshot({ path: test.info().outputPath("conversation-browser-thumbnail.png") });
    await thumbnail.click();
    await expect(thumbnailRow).toHaveCount(0);
    await expect(page.getByTestId("browser-observation-preview")).toHaveCount(0);
    await expect(guestFrame).toHaveCSS("opacity", "1");
    // Narrow mode also reveals the original pane via the same focus path.
    await setWindowSize(ctx.app, 900, 700);
    await page.getByTestId(`sidebar-session-${click.target.hostSessionId}`).click();
    await expect(thumbnail).toBeVisible();
    await thumbnail.click();
    await expect(thumbnailRow).toHaveCount(0);
    await setWindowSize(ctx.app, 1280, 800);
    // Focusing the hidden pane carried the maximize to it; restore the split so the conversation and its approvals show again.
    await page.locator('[data-testid="pane-maximize"][aria-pressed="true"]:visible').click();
    await expect(page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]:visible').first()).toBeVisible();

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

    // Paused observation must not keep a hidden guest painting.
    await page.getByTestId("pane-cell:main").getByTestId("pane-maximize").click();
    await expect(guestFrame).toHaveCSS("visibility", "hidden");
    await expect(guestFrame).toHaveCSS("opacity", "1");
    await expect(guestFrame).not.toHaveAttribute("inert", "");
    await expect(thumbnailRow).toHaveCount(0);
    await page.getByTestId(`sidebar-surface-${rendererTabId}`).click();
    await page.getByTestId("pane").filter({ has: page.getByTestId("agent-browser-control-resume") }).getByTestId("pane-close").click();
    await expect(guestFrame).toHaveCount(0);

    // Closing the focused pane leaves the maximize on a neighbour; restore the split to see the conversation finish.
    await page.locator('[data-testid="pane-maximize"][aria-pressed="true"]:visible').click();
    releaseFinish!();
    await expect(page.getByTestId("chat-main-column").getByText("Preview task complete.", { exact: true })).toBeVisible({ timeout: 60_000 });
    approving = false;
    await approvals;
    // Preview frames never entered the observation stream.
    const observed = (await readCapture()).observed;
    expect(JSON.stringify(observed)).not.toContain("image/jpeg");
    // Re-showing panes mounts terminal activity views, which publish empty snapshots; nothing else may appear.
    expect(observed.filter((event) => event.source === "terminal")
      .every((event) => event.kind === "snapshot" && JSON.stringify(event.after) === '{"commands":[]}')).toBe(true);
    expect(observed.filter((event) => event.source !== "terminal")
      .every((event) => event.source === "browser" && event.actor === "agent")).toBe(true);
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
}
