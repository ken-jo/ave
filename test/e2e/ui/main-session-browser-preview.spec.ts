import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { EventEmitter } from "node:events";
import { TOOL_TIMEOUT_POLICY } from "../../../src/shared/tool-timeout-policy.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron, setWindowSize } from "./seeded-electron.js";
import { browserHostIdentity, browserTargetId, inspectBrowserTarget } from "./browser-native-target.js";

type PreviewLifecycleEntry = { kind: "start" | "stop" | "navigation-start" | "navigation-commit"; ts: number; url?: string; error?: string };

// A static, never-revealed page must deliver its first picture through the real observation and screencast path.
test.use({ trace: "on" });
for (const deviceScale of [1, 2]) {
  for (const appZoom of [0.9, 1, 1.25, 1.5]) {
    for (const guestZoom of appZoom === 1 ? [1, 1.25] : [1, appZoom]) {
      test(`@os-focus clicks a parked ref across origins at app zoom ${appZoom} page zoom ${guestZoom} scale ${deviceScale}`,
        { annotation: { type: "isolated-app", description: "Native focus and process-wide input instrumentation require a dedicated process" } },
        () => exerciseParkedClick(deviceScale, appZoom, guestZoom));
    }
  }
}

async function exerciseParkedClick(deviceScale: number, appZoom: number, guestZoom: number): Promise<void> {
  const previewShown = deviceScale === 1;
  const editsAtHandoff = deviceScale === 1 && appZoom === 1.25 && guestZoom === 1;
  test.setTimeout(90_000);
  const model = "static-browser-preview-fixture";
  let stage = 0;
  let firstUrl = "";
  let secondUrl = "";
  let tabId = "";
  let clickRef = "";
  let releaseNavigation: (() => void) | undefined;
  let releaseFinish: (() => void) | undefined;
  const failures: string[] = [];
  const toolResults: string[] = [];
  const requestedTools: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "static-preview", object: "chat.completion.chunk", created: 0,
      model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const tool = (response: ServerResponse, name: string, args: Record<string, unknown>) => {
    requestedTools.push(name);
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
      response.end(`<!doctype html><html><head><title>Static example</title></head><body style="font:20px system-ui;padding:40px;background:${request.url.includes("second") ? "#c8e8ff" : "#fff8e0"}"><h1>${request.url.includes("second") ? "Example destination" : "Example source"}</h1>${request.url.includes("second") ? "" : Array.from({ length: 22 }, (_, index) => `<p>Documentation paragraph ${index + 1}. ${"A long static document keeps the destination link below the initial viewport. ".repeat(3)}</p>`).join("")}<a href="${secondUrl}">Learn more</a><p>A static page without animation.</p></body></html>`); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    const result = body.messages?.findLast(message => message.role === "tool")?.content;
    const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
    if (stage > 0) toolResults.push(text);
    if (/"error"\s*:/.test(text)) failures.push(text);
    stage += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (stage === 1) { tool(response, "browser_navigate", { url: firstUrl }); return; }
    if (stage === 2) {
      tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(text)?.[1] ?? "";
      if (!ctx) throw new Error("Browser fixture unavailable");
      const zoom = await ctx.page.evaluate(async ({ url, factor }) => {
        const workspace = window.aveApi.browserWorkspace;
        const state = await workspace?.getState();
        const target = state?.ok ? state.value.tabs.find(tab => tab.url === url) : undefined;
        if (!workspace || !target) throw new Error("Browser zoom target unavailable");
        const result = await workspace.zoom({ tabId: target.tabId, documentGeneration: target.documentGeneration, factor });
        if (!result.ok) throw new Error("Browser zoom request refused");
        return result.value.factor;
      }, { url: firstUrl, factor: guestZoom });
      expect(zoom).toBeCloseTo(guestZoom);
      tool(response, "browser_snapshot", { tabId, interactive: true }); return;
    }
    if (stage === 3) {
      clickRef = /link "Learn more"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      releaseNavigation = () => tool(response, "browser_click", { tabId, ref: clickRef });
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
  let bodyFailure: { error: unknown } | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "Static browser preview", settings, historyRows: [],
      launchEnv: { AVE_NATIVE_FIXTURE_MODE: "foreground" },
      launchArgs: ["--use-mock-keychain", `--force-device-scale-factor=${deviceScale}`] });
    const host = await browserHostIdentity(ctx.app, ctx.page);
    await ctx.app.evaluate(({ app, BaseWindow, webContents }, { delayHitMs, edits, windowId, chromeId }) => {
      const owner = BaseWindow.fromId(windowId);
      const chrome = webContents.fromId(chromeId);
      if (!owner || !chrome || Reflect.get(owner, "webContents") !== chrome) throw new Error("Native foreground owner unavailable");
      const capture = globalThis as unknown as { clickMeasurements: unknown[]; pointerEchoes: unknown[]; destructionPeaks: Record<string, number>; listenerWarnings: string[]; previewLifecycle: PreviewLifecycleEntry[] };
      capture.clickMeasurements = [];
      capture.pointerEchoes = [];
      capture.destructionPeaks = {};
      capture.listenerWarnings = [];
      capture.previewLifecycle = [];
      process.on("warning", warning => { if (warning.name === "MaxListenersExceededWarning") capture.listenerWarnings.push(warning.message); });
      app.on("web-contents-created", (_event, contents) => {
        const id = String(contents.id);
        capture.destructionPeaks[id] = contents.listenerCount("destroyed");
        (contents as unknown as EventEmitter).on("newListener", (event: string | symbol) => {
          if (event === "destroyed") capture.destructionPeaks[id] = Math.max(capture.destructionPeaks[id] ?? 0, contents.listenerCount("destroyed") + 1);
        });
        contents.on("input-event", (_event, input) => {
          if (input.type === "mouseMove") capture.pointerEchoes.push({ input, guestZoom: contents.getZoomFactor(), hostZoom: chrome.getZoomFactor() });
        });
        contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) capture.previewLifecycle.push({ kind: "navigation-start", ts: Date.now(), url });
        });
        contents.on("did-navigate", (_event, url) => capture.previewLifecycle.push({ kind: "navigation-commit", ts: Date.now(), url }));
        const protocol = contents.debugger;
        const send = protocol.sendCommand.bind(protocol);
        let nodeId: number | undefined;
        let delayed = false;
        let foregroundPrepared = false;
        let quads: number[][] | undefined;
        let chosenPoint: { x: number; y: number } | undefined;
        protocol.sendCommand = async (method, params = {}) => {
          if (method === "Page.startScreencast" || method === "Page.stopScreencast") {
            const entry: PreviewLifecycleEntry = { kind: method === "Page.startScreencast" ? "start" : "stop", ts: Date.now() };
            capture.previewLifecycle.push(entry);
            try { return await send(method, params); }
            catch (error) { entry.error = String(error); throw error; }
          }
          if (method === "DOM.getContentQuads" && typeof params.backendNodeId === "number") {
            nodeId = params.backendNodeId;
            const result = await send(method, params);
            quads = result.quads;
            const quad = quads?.find(candidate => candidate.length === 8);
            if (quad) chosenPoint = { x: Math.round(quad.filter((_value, index) => index % 2 === 0).reduce((sum, value) => sum + value, 0) / 4), y: Math.round(quad.filter((_value, index) => index % 2 !== 0).reduce((sum, value) => sum + value, 0) / 4) };
            return result;
          }
          if (edits && method === "Input.dispatchTouchEvent" && params.type === "touchStart") {
            const result = await send(method, params);
            // A user can start editing after the press begins, before its completion handoff.
            await chrome.mainFrame.executeJavaScript(`(() => {
              window.parkedEditProbe = { blurs: 0 };
              const editor = document.createElement("input");
              editor.dataset.testid = "parked-edit-probe";
              editor.value = "Unfinished rename draft";
              editor.style.cssText = "position:fixed;left:8px;top:8px;z-index:9999";
              editor.addEventListener("blur", () => { window.parkedEditProbe.blurs++; editor.remove(); });
              document.body.append(editor);
              editor.focus();
            })()`);
            return result;
          }
          if (method !== "DOM.getNodeForLocation") return send(method, params);
          if (!delayed && delayHitMs > 0) {
            delayed = true;
            await new Promise(resolve => setTimeout(resolve, delayHitMs));
          }
          // An inactive window cannot own native keyboard input; retain its frame state separately.
          if (!foregroundPrepared) {
            foregroundPrepared = true;
            app.focus({ steal: true });
            owner.focus();
            const deadline = Date.now() + 1_000;
            while (!owner.isFocused() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            if (!owner.isFocused()) throw new Error("Native foreground precondition unavailable");
          }
          const geometry = async () => ({ ts: Date.now(), guestZoom: contents.getZoomFactor(), hostZoom: chrome.getZoomFactor(),
            focused: webContents.getFocusedWebContents()?.id === contents.id,
            rootViewFocused: contents.isFocused(), hostViewFocused: chrome.isFocused(),
            windowFocused: owner.isFocused(),
            hostFrame: chrome.focusedFrame?.frameTreeNodeId, hostMainFrame: chrome.mainFrame.frameTreeNodeId,
            throttled: contents.getBackgroundThrottling(),
            editor: await chrome.mainFrame.executeJavaScript("({ blurs: window.parkedEditProbe?.blurs, draft: document.querySelector('[data-testid=parked-edit-probe]')?.value })"),
            layout: await send("Page.getLayoutMetrics"),
            box: nodeId === undefined ? null : await send("DOM.getBoxModel", { backendNodeId: nodeId }),
            viewport: await send("Runtime.evaluate", { expression: "({ width: innerWidth, height: innerHeight, deviceScale: devicePixelRatio, scrollX, scrollY, visibility: document.visibilityState })", returnByValue: true }),
          });
          try {
            const result = await send(method, params);
            capture.clickMeasurements.push({ guestId: contents.id, chosenPoint, quads, point: params, result, ...await geometry() });
            return result;
          } catch (error) {
            capture.clickMeasurements.push({ guestId: contents.id, point: params, error: String(error), ...await geometry() });
            throw error;
          }
        };
      });
    }, { delayHitMs: previewShown ? 0 : TOOL_TIMEOUT_POLICY.browserLayoutIdleGraceMs + 250, edits: editsAtHandoff, windowId: host.windowId, chromeId: host.chromeId });
    await setWindowSize(ctx.app, 1200, 800);
    const hostFactor = await ctx.app.evaluate(({ webContents }, input) => {
      const chrome = webContents.fromId(input.chromeId);
      if (!chrome) throw new Error("App zoom target unavailable");
      chrome.setZoomFactor(input.factor);
      return chrome.getZoomFactor();
    }, { chromeId: host.chromeId, factor: appZoom });
    expect(hostFactor).toBeCloseTo(appZoom);
    const { app, page } = ctx;
    const panelToggle = page.getByTestId(TEST_IDS.panePanelToggle);
    await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-static-preview");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const state = window as unknown as { previewCapture: unknown[] };
      state.previewCapture = [];
      const activity = window as unknown as { activityOps: unknown[] };
      activity.activityOps = [];
      window.aveApi.browserTabs?.onTabOp(op => { if (op.op === "wake" || op.op === "sleep") activity.activityOps.push({ op: op.op, ts: Date.now() }); });
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
    const preview = page.getByTestId("agent-browser-pip-card").getByTestId("browser-observation-preview");
    if (!previewShown) {
      await page.getByTestId("agent-browser-pip-card").getByRole("button", { name: /^(Hide browser preview:|브라우저 미리보기 숨기기:)/ }).click();
      await expect(page.getByTestId("agent-browser-pip-card")).toHaveCount(0);
    }
    let firstPicture: string | null = null;
    if (previewShown) {
      await expect(preview).toBeVisible();
      let previewFailure: { error: unknown } | undefined;
      try {
        await expect(preview.locator("img")).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => preview.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      } catch (error) {
        previewFailure = { error };
      }
      let capture: unknown[] = [];
      try {
        capture = await page.evaluate(() => (window as unknown as { previewCapture: unknown[] }).previewCapture);
        await test.info().attach("static-preview-messages.json", { body: JSON.stringify(capture), contentType: "application/json" });
        const guests = await ctx.app.evaluate(async ({ webContents }, url) => Promise.all(webContents.getAllWebContents().filter(contents => contents.getURL() === url).map(async contents => ({ url: contents.getURL(), type: contents.getType(), embedded: Boolean(contents.hostWebContents), focused: contents.isFocused(), layout: await contents.executeJavaScript("({ visibility: document.visibilityState, width: innerWidth, height: innerHeight })") }))), firstUrl);
        await test.info().attach("static-preview-guests.json", { body: JSON.stringify(guests), contentType: "application/json" });
      } catch (error) {
        if (!previewFailure) throw error;
        console.warn("Could not collect parked preview diagnostics", error);
      }
      if (previewFailure) throw previewFailure.error;
      expect(capture).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "frame", tabId })]));
      await test.info().attach("static-preview.png", { body: await page.screenshot(), contentType: "image/png" });
      await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
      firstPicture = await preview.locator("img").getAttribute("src");
    }
    if (deviceScale === 1 && appZoom === 1.25 && guestZoom === 1.25) {
      for (const level of [1, 2]) {
        const updated = await page.evaluate(level => window.aveApi.updateSettings({ appearance: { zoomLevel: level } }), level);
        expect(updated).toMatchObject({ appearance: { zoomLevel: level } });
        const factors = await ctx.app.evaluate(({ webContents }, input) => ({
          host: webContents.fromId(input.chromeId)?.getZoomFactor(),
          guest: webContents.getAllWebContents().find(contents => contents.getURL() === input.url)?.getZoomFactor(),
        }), { chromeId: host.chromeId, url: firstUrl });
        expect(factors.host).toBeCloseTo(1.2 ** level);
        expect(factors.guest).toBeCloseTo(guestZoom);
      }
      await ctx.app.evaluate(({ webContents }, input) => webContents.fromId(input.chromeId)?.setZoomFactor(input.factor), { chromeId: host.chromeId, factor: appZoom });
    }
    const nativeId = await browserTargetId(ctx.app, firstUrl);
    const parkedLayout = await ctx.app.evaluate(async ({ webContents }, id) => {
      const target = webContents.fromId(id);
      if (!target) throw new Error("Parked native page unavailable");
      return target.executeJavaScript("({width:innerWidth,height:innerHeight,visibility:document.visibilityState})");
    }, nativeId);
    expect(await inspectBrowserTarget(ctx.app, host.windowId, firstUrl)).toMatchObject({ id: nativeId, type: "window", embedded: false, attached: false });
    expect(Math.abs(parkedLayout.width * guestZoom - 1024)).toBeLessThanOrEqual(guestZoom);
    expect(Math.abs(parkedLayout.height * guestZoom - 768)).toBeLessThanOrEqual(guestZoom);
    if (previewShown) expect(parkedLayout.visibility).toBe("visible");
    await test.info().attach("parked-placement.json", { body: JSON.stringify(parkedLayout), contentType: "application/json" });
    expect(clickRef).toMatch(/^e\d+$/);
    releaseNavigation?.();
    await expect.poll(() => releaseFinish !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    if (previewShown) {
      await expect(preview.locator("img")).not.toHaveAttribute("src", firstPicture ?? "");
      await expect.poll(() => preview.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect.poll(() => preview.locator("img").evaluate((element) => {
        const image = element as HTMLImageElement;
        const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext("2d"); if (!context) throw new Error("Image pixel reader unavailable");
        context.drawImage(image, image.naturalWidth / 2, image.naturalHeight * 0.85, 1, 1, 0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return [200, 232, 255].every((channel, index) => Math.abs((pixel[index] ?? -255) - channel) <= 6);
      })).toBe(true);
      await test.info().attach("static-cross-site-preview.png", { body: await page.screenshot(), contentType: "image/png" });
      await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
    }
    const previewApp = ctx.app;
    await test.step("keeps preview commands attached across cross-origin navigation", async () => {
      const lifecycle = await previewApp.evaluate(() => (globalThis as unknown as { previewLifecycle: PreviewLifecycleEntry[] }).previewLifecycle);
      await test.info().attach("preview-lifecycle.json", { body: JSON.stringify(lifecycle, null, 2), contentType: "application/json" });
      expect(lifecycle).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "navigation-commit", url: secondUrl })]));
      expect(lifecycle.filter((entry) => entry.error)).toEqual([]);
      if (previewShown) {
        const commit = lifecycle.findLastIndex((entry) => entry.kind === "navigation-commit" && entry.url === secondUrl);
        expect(lifecycle.slice(commit + 1).some((entry) => entry.kind === "start")).toBe(true);
      }
    });
    const hits = await ctx.app.evaluate(() => (globalThis as unknown as { clickMeasurements: Array<{ hostZoom?: number; guestZoom: number }> }).clickMeasurements);
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit).toMatchObject({ windowFocused: true, focused: false, throttled: false, result: { backendNodeId: expect.any(Number), frameId: expect.any(String) } });
      expect(hit.hostZoom).toBeCloseTo(appZoom);
      expect(hit.guestZoom).toBeCloseTo(guestZoom);
    }
    if (editsAtHandoff) expect(hits[2]).toMatchObject({ editor: { blurs: 0, draft: "Unfinished rename draft" } });
    const destruction = await ctx.app.evaluate(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const state = globalThis as unknown as { destructionPeaks: Record<string, number>; listenerWarnings: string[] };
      return { peaks: Object.values(state.destructionPeaks), warnings: state.listenerWarnings };
    });
    await test.info().attach("guest-destruction-listeners.json", { body: JSON.stringify(destruction), contentType: "application/json" });
    console.log("Guest destruction listener budget", JSON.stringify(destruction));
    expect(destruction.peaks).toHaveLength(1);
    for (const peak of destruction.peaks) { expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(7); }
    expect(destruction.warnings).toEqual([]);
    expect(requestedTools).toEqual(["browser_navigate", "browser_snapshot", "browser_click", "browser_snapshot"]);
    expect(toolResults[2]).toContain(secondUrl);
    expect(toolResults[3]).toContain("Example destination");
    const beforeEnd = await page.evaluate(async handle => (await window.aveApi.browserTabs?.getState())?.tabs.find(tab => tab.tabId === handle), tabId);
    expect(beforeEnd).toMatchObject({ mode: "agent-active", url: secondUrl });
    releaseFinish?.();
    await expect(page.getByTestId("chat-main-column").getByText("Static preview task complete.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("agent-browser-pip-card")).toHaveCount(0, { timeout: 3_000 });
    await expect(page.getByTestId("browser-observation-preview")).toHaveCount(0);
    await expect.poll(() => page.evaluate(async handle => (await window.aveApi.browserTabs?.getState())?.tabs.find(tab => tab.tabId === handle)?.mode, tabId)).toBe("human");
    const afterEnd = await page.evaluate(async handle => (await window.aveApi.browserTabs?.getState())?.tabs.find(tab => tab.tabId === handle), tabId);
    expect(afterEnd).toMatchObject({ tabId, owner: beforeEnd?.owner, url: secondUrl });
    await panelToggle.click();
    if (!afterEnd?.rendererTabId) throw new Error("Retained browser slot unavailable");
    await page.locator(`[role="presentation"][data-tab-id="${afterEnd.rendererTabId}"]`).getByRole("tab").click();
    const retainedFrame = page.locator(`[data-testid="chat-side-panel-browser-native"][data-tab-id="${afterEnd.rendererTabId}"]`);
    await expect(retainedFrame).toHaveCSS("visibility", "visible");
    await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, secondUrl)).attached).toBe(true);
    await expect(page.getByTestId("agent-browser-control-badge")).toHaveCount(0);
    await expect(page.getByTestId("chat-side-panel-tab-agent-controlled")).toHaveCount(0);
    const retained = await ctx.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter(contents => contents.getURL() === url).map(contents => ({ id: contents.id, url: contents.getURL(), destroyed: contents.isDestroyed() })), secondUrl);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ id: nativeId, url: secondUrl, destroyed: false });
    // Explicit trusted-chrome focus must move actual native ownership to the visible page.
    const focused = await page.evaluate(async target => {
      const tabs = window.aveApi.browserTabs;
      if (!tabs) throw new Error("Native browser focus API unavailable");
      return tabs.nativeSurface({ action: "focus", tabId: target.rendererTabId, webContentsId: target.id });
    }, { rendererTabId: afterEnd.rendererTabId, id: nativeId });
    expect(focused.ok).toBe(true);
    const running = ctx;
    const keyboardTarget = () => running.app.evaluate(({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === url);
      if (!guest) throw new Error("Native keyboard target unavailable");
      const focused = webContents.getFocusedWebContents()?.id === guest.id;
      return { focused, guestFrame: focused && guest.focusedFrame === guest.mainFrame };
    }, secondUrl);
    await expect.poll(keyboardTarget).toEqual({ focused: true, guestFrame: true });
    await page.getByTestId("chat-side-panel-close").click();
    await expect.poll(keyboardTarget).toEqual({ focused: false, guestFrame: false });
    // Native parking must not change a background window's current focus or activate it.
    const inactiveGuest = retained[0];
    if (!inactiveGuest || !afterEnd?.rendererTabId) throw new Error("Retained guest binding unavailable");
    await page.evaluate(() => {
      const editor = document.createElement("input");
      editor.dataset.testid = "background-edit-probe";
      editor.value = "Background draft";
      document.body.append(editor);
      editor.focus();
      const state = window as unknown as { backgroundEditBlurs: number };
      state.backgroundEditBlurs = 0;
      editor.addEventListener("blur", () => { state.backgroundEditBlurs++; });
    });
    await ctx.app.evaluate(({ BaseWindow }, windowId) => BaseWindow.fromId(windowId)?.blur(), host.windowId);
    await expect.poll(() => running.app.evaluate(({ BaseWindow }, windowId) => BaseWindow.fromId(windowId)?.isFocused(), host.windowId)).toBe(false);
    const backgroundBefore = await page.evaluate(() => ({ blurs: (window as unknown as { backgroundEditBlurs: number }).backgroundEditBlurs,
      active: document.activeElement?.getAttribute("data-testid"), value: (document.activeElement as HTMLInputElement)?.value }));
    expect(backgroundBefore).toMatchObject({ active: "background-edit-probe", value: "Background draft" });
    const parking = await page.evaluate(async tabId => {
      const tabs = window.aveApi.browserTabs;
      if (!tabs) throw new Error("Native browser parking API unavailable");
      const acquired = await tabs.nativeSurface({ action: "create", tabId });
      if (!acquired.ok || !acquired.surface) throw new Error("Retained native surface unavailable");
      return tabs.nativeSurface({ action: "present", tabId, webContentsId: acquired.surface.webContentsId,
        epoch: acquired.surface.epoch, sequence: 1, bounds: null });
    }, afterEnd.rendererTabId);
    expect(parking).toMatchObject({ ok: true, surface: { tabId: afterEnd.rendererTabId,
      webContentsId: inactiveGuest.id, visible: false } });
    expect(await ctx.app.evaluate(({ BaseWindow }, windowId) => BaseWindow.fromId(windowId)?.isFocused(), host.windowId)).toBe(false);
    expect(await page.evaluate(() => ({ blurs: (window as unknown as { backgroundEditBlurs: number }).backgroundEditBlurs,
      active: document.activeElement?.getAttribute("data-testid"), value: (document.activeElement as HTMLInputElement)?.value })))
      .toEqual(backgroundBefore);
    await test.info().attach("turn-ended-retained-tab.png", { body: await page.screenshot(), contentType: "image/png" });
  } catch (error) {
    bodyFailure = { error };
  }
  try {
    try {
      if (ctx) {
        const lifecycle = await ctx.app.evaluate(() => (globalThis as unknown as { previewLifecycle: PreviewLifecycleEntry[] }).previewLifecycle);
        await test.info().attach("preview-lifecycle-final.json", { body: JSON.stringify(lifecycle, null, 2), contentType: "application/json" });
        console.log("Activity operations", JSON.stringify(await ctx.page.evaluate(() => (window as unknown as { activityOps: unknown[] }).activityOps)));
        const measurements = await ctx.app.evaluate(() => (globalThis as unknown as { clickMeasurements: unknown[] }).clickMeasurements);
        const echoes = await ctx.app.evaluate(() => (globalThis as unknown as { pointerEchoes: unknown[] }).pointerEchoes);
        console.log("Native zoom pointer measurements", JSON.stringify(echoes));
        await test.info().attach("native-pointer-echoes.json", { body: JSON.stringify(echoes, null, 2), contentType: "application/json" });
        console.log("Parked click hit-test count", measurements.length);
        await test.info().attach("parked-click-geometry.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
      }
    } finally {
      approving = false;
      try {
        if (approvals) await approvals;
      } finally {
        try {
          if (ctx) await teardownSeededElectron(ctx, { terminate: true });
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      }
    }
  } catch (error) {
    if (!bodyFailure) throw error;
    console.warn("Parked preview cleanup failed after the test error", error);
  }
  if (bodyFailure) throw bodyFailure.error;
}
