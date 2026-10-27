import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import type { AgentObservationEvent } from "../../../src/shared/agent-observation.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

interface BrowserGuestGeometry {
  at: number;
  bounds: { x: number; y: number; width: number; height: number };
  strip: boolean;
  control: boolean;
}

function expectStableBrowserBounds(geometry: BrowserGuestGeometry[]): void {
  const mounted = geometry.filter(({ bounds }) => bounds.x > 0 && bounds.y > 0 && bounds.width > 0 && bounds.height > 0);
  expect(mounted.length).toBeGreaterThan(0);
  expect(new Set(mounted.map(({ bounds }) => JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height]))).size).toBe(1);
}

test("shows admitted browser commands and excludes a later user navigation from the same tab", async () => {
  test.setTimeout(150_000);
  const model = "browser-observation-fixture";
  const typedValue = "browser-input-value-omitted-from-observations";
  let stage = 0;
  let tabId = "";
  let clickRef = "";
  let typeRef = "";
  let releaseTyping: (() => void) | undefined;
  let releaseNavigation: (() => void) | undefined;
  let pageUrl = "";
  const failures: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "browser-observation", object: "chat.completion.chunk", created: 0,
      model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const tool = (response: ServerResponse, name: string, args: Record<string, unknown>) => {
    send(response, { role: "assistant", tool_calls: [{ index: 0, id: `browser-observation-${stage}`, type: "function",
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
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><title>Browser observation fixture</title></head><body style="font:16px system-ui;padding:32px"><h1 style="font-size:26px">Agent browser activity</h1><div style="display:grid;gap:16px"><button id="agent-click" style="padding:10px" onclick="document.querySelector('output').textContent='Clicked'">Continue</button><label>Search <input aria-label="Search"></label><output>Ready</output><a id="user-link" href="/page?user=1">User page</a></div>
<script>
window.inputEvents = [];
for (const type of ['touchstart', 'touchend', 'touchcancel', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
  document.addEventListener(type, (event) => {
    const point = event.changedTouches?.[0] ?? event;
    const button = document.getElementById('agent-click').getBoundingClientRect();
    window.inputEvents.push({ at: Date.now(), type, target: event.target.tagName, id: event.target.id,
      x: point.clientX, y: point.clientY, screenX: point.screenX, screenY: point.screenY,
      trusted: event.isTrusted, pointerType: event.pointerType, button: button.toJSON(),
      output: document.querySelector('output').textContent });
  }, true);
}
</script></body></html>`);
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
    if (stage === 1) { tool(response, "browser_tab_new", { url: pageUrl }); return; }
    if (stage === 2) {
      tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(text)?.[1] ?? "";
      tool(response, "browser_tabs", { select: tabId }); return;
    }
    if (stage === 3) { tool(response, "browser_snapshot", { tabId, interactive: true }); return; }
    if (stage === 4) {
      clickRef = /button "Continue"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      typeRef = /textbox "Search"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      tool(response, "browser_click", { tabId, ref: clickRef }); return;
    }
    if (stage === 5) {
      releaseTyping = () => tool(response, "browser_type", { tabId, ref: typeRef, text: typedValue });
      response.flushHeaders(); return;
    }
    if (stage === 6) {
      releaseNavigation = () => tool(response, "browser_navigate", { tabId, url: `${pageUrl}?finished=1` });
      response.flushHeaders(); return;
    }
    send(response, { role: "assistant", content: "Browser task complete." }, null);
    send(response, {}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  pageUrl = `${origin}/page`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `${origin}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  let approving = true;
  let approvals: Promise<void> | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "Agent browser observation", settings, historyRows: [],
      launchArgs: ["--use-mock-keychain"] });
    const runtime = await ctx.app.evaluate(() => ({ executable: process.execPath, aveHome: process.env.AVE_HOME,
      mockKeychain: process.argv.includes("--use-mock-keychain"), pid: process.pid }));
    expect(runtime.aveHome).toBe(ctx.aveHome);
    expect(runtime.mockKeychain).toBe(true);
    const runtimePath = test.info().outputPath("isolated-browser-runtime.json");
    writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
    await test.info().attach("isolated-browser-runtime", { path: runtimePath, contentType: "application/json" });
    await ctx.app.evaluate(({ app }) => {
      const state = globalThis as unknown as { browserFixtureConsole: unknown[]; browserFixtureCrashes: unknown[]; browserFixtureInput: unknown[] };
      state.browserFixtureConsole = [];
      state.browserFixtureCrashes = [];
      state.browserFixtureInput = [];
      app.on("web-contents-created", (_event, contents) => {
        contents.on("console-message", (event) => state.browserFixtureConsole.push({ guestId: contents.id,
          level: event.level, message: event.message, line: event.lineNumber }));
        contents.on("render-process-gone", (_event, details) => state.browserFixtureCrashes.push({ guestId: contents.id, ...details }));
        const recordInput = (channel: string, input: unknown) => {
          const value = input as Record<string, unknown>;
          state.browserFixtureInput = [...state.browserFixtureInput.slice(-255), { at: Date.now(), channel,
            guestId: contents.id, type: value.type, _modifiers: value._modifiers, x: value.x, y: value.y,
            globalX: value.globalX, globalY: value.globalY, button: value.button, clickCount: value.clickCount }];
        };
        contents.on("input-event", (_event, input) => recordInput("input-event", input));
        contents.on("before-input-event", (_event, input) => recordInput("before-input-event", input));
      });
    });
    const page = ctx.page;
    const errors: string[] = [];
    page.on("crash", () => errors.push("Main renderer crashed"));
    page.on("pageerror", (error) => errors.push(error.message));
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: {
      reviewer: { interactive: { autoApprove: "off" } } } }));
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) throw new Error("Browser fixture window unavailable");
      window.setContentSize(1280, 860);
    });
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 1280, height: 860 });
    await expect.poll(() => ctx!.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) throw new Error("Browser fixture window unavailable");
      const { width, height } = window.getContentBounds();
      return { width, height };
    })).toEqual({ width: 1280, height: 860 });
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-browser");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const capture = window as unknown as { browserObservationEvents: AgentObservationEvent[]; browserGuestGeometry: unknown[];
        browserControlTransitions: unknown[] };
      capture.browserObservationEvents = [];
      capture.browserGuestGeometry = [];
      capture.browserControlTransitions = [];
      window.ave.preview.onAgentObservation((events) => capture.browserObservationEvents.push(...events));
      window.aveApi.browserTabs!.onControl((state) => {
        capture.browserControlTransitions = [...capture.browserControlTransitions.slice(-127), { at: Date.now(), revision: state.revision,
          tabs: state.tabs.map(({ tabId, rendererTabId, mode, generation }) => ({ tabId, rendererTabId, mode, generation })) }];
      });
      let previous = "";
      const measure = () => {
        const guest = document.querySelector('[data-testid="chat-side-panel-browser-webview"]');
        if (guest) {
          const bounds = guest.getBoundingClientRect().toJSON();
          const state = { bounds, strip: document.querySelector('[data-testid="browser-preview-live-strip"]') !== null,
            control: document.querySelector('[data-testid="agent-browser-control-badge"]') !== null };
          const next = JSON.stringify(state);
          if (next !== previous) {
            capture.browserGuestGeometry = [...capture.browserGuestGeometry.slice(-63), { at: Date.now(), ...state }];
            previous = next;
          }
        }
        requestAnimationFrame(measure);
      };
      requestAnimationFrame(measure);
    });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(page.getByTestId("browser-preview-live-strip")).toHaveCount(0);
    const composer = page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    await composer.fill("Complete the local browser fixture.");
    await composer.press("Enter");
    approvals = (async () => {
      const deadline = Date.now() + 100_000;
      while (approving && Date.now() < deadline) {
        const button = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
        if (await button.isVisible()) await button.click();
        await page.waitForTimeout(100);
      }
    })();
    await expect.poll(() => releaseTyping !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    expect(tabId).toMatch(/^tab-\d+$/);
    expect(clickRef).toMatch(/^e\d+$/);
    expect(typeRef).toMatch(/^e\d+$/);
    const strip = page.getByTestId("browser-preview-live-strip");
    await expect(strip).toContainText("에이전트 브라우징");
    await expect(strip).toContainText("클릭: ‘Continue’");
    const guestId = await page.getByTestId("chat-side-panel-browser-webview").evaluate((element) =>
      (element as unknown as { getWebContentsId(): number }).getWebContentsId());
    try {
      await expect.poll(() => ctx!.app.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id);
        if (!guest) throw new Error("Browser fixture guest unavailable");
        return guest.executeJavaScript("document.querySelector('output').textContent");
      }, guestId)).toBe("Clicked");
    } finally {
      const diagnostic = await ctx.app.evaluate(async ({ BrowserWindow, webContents }, id) => {
        const guest = webContents.fromId(id);
        if (!guest) throw new Error("Browser fixture guest unavailable");
        const state = globalThis as unknown as { browserFixtureConsole: unknown[]; browserFixtureCrashes: unknown[]; browserFixtureInput: unknown[] };
        const dom = await guest.executeJavaScript(`(() => {
          const button = document.getElementById('agent-click');
          const output = document.querySelector('output');
          return { output: output.textContent, onclick: typeof button.onclick, focused: document.hasFocus(),
            activeElement: document.activeElement.tagName, button: button.getBoundingClientRect().toJSON(),
            outputBounds: output.getBoundingClientRect().toJSON(), events: window.inputEvents,
            viewport: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, screenX, screenY,
              clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
              scale: visualViewport?.scale } };
        })()`);
        const windows = await Promise.all(BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map(async (window) => ({
          id: window.id, contentBounds: window.getContentBounds(), bounds: window.getBounds(),
          viewport: await window.webContents.executeJavaScript("({ innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio, screenX, screenY, scale: visualViewport?.scale })"),
        })));
        return { guestId: id, dom, windows, nativeInput: state.browserFixtureInput,
          console: state.browserFixtureConsole, crashes: state.browserFixtureCrashes };
      }, guestId);
      const guestBounds = await page.getByTestId("chat-side-panel-browser-webview").boundingBox();
      const geometry = await page.evaluate(() => (window as unknown as { browserGuestGeometry: BrowserGuestGeometry[] }).browserGuestGeometry);
      const control = await page.evaluate(() => (window as unknown as { browserControlTransitions: unknown[] }).browserControlTransitions);
      const proof = { ...diagnostic, guestBounds, geometry, control };
      console.log("Browser click effect evidence", JSON.stringify(proof));
      const proofPath = test.info().outputPath("browser-click-effect.json");
      writeFileSync(proofPath, JSON.stringify(proof, null, 2));
      await test.info().attach("browser-click-effect", { path: proofPath, contentType: "application/json" });
      const screenshot = test.info().outputPath("agent-browser-click.png");
      await page.screenshot({ path: screenshot });
      await test.info().attach("agent-browser-click", { path: screenshot, contentType: "image/png" });
    }
    expectStableBrowserBounds(await page.evaluate(() =>
      (window as unknown as { browserGuestGeometry: BrowserGuestGeometry[] }).browserGuestGeometry));
    await expect(page.getByTestId("agent-browser-control-resume")).toHaveCount(0);
    releaseTyping!();
    await expect.poll(() => releaseNavigation !== undefined).toBe(true);
    expect(failures).toEqual([]);
    await expect.poll(() => ctx!.app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error("Browser fixture guest unavailable");
      return guest.executeJavaScript("document.querySelector('input').value");
    }, guestId)).toBe(typedValue);
    releaseNavigation!();
    await expect(page.getByTestId("chat-main-column").getByText("Browser task complete.", { exact: true })).toBeVisible({ timeout: 60_000 });
    approving = false;
    await approvals;
    const readEvents = () => page.evaluate(() => (window as unknown as { browserObservationEvents: AgentObservationEvent[] }).browserObservationEvents);
    await expect.poll(async () => (await readEvents()).some((event) => event.source === "browser"
      && event.kind === "action" && event.after.action === "navigate")).toBe(true);
    const events = await readEvents();
    expect(failures).toEqual([]);
    expect(events.every((event) => event.source === "browser" && event.actor === "agent")).toBe(true);
    expect(events.filter((event) => event.source === "browser" && event.kind === "action").map((event) => event.after.action))
      .toEqual(expect.arrayContaining(["tab-open", "tab-switch", "click", "type", "navigate"]));
    expect(JSON.stringify(events)).not.toContain(typedValue);
    const userUrl = `${pageUrl}?user=1`;
    await ctx.app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error("Browser fixture guest unavailable");
      const point = await guest.executeJavaScript("(() => { const bounds = document.getElementById('user-link').getBoundingClientRect(); return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }; })()") as { x: number; y: number };
      guest.focus();
      guest.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    }, guestId);
    await expect(page.getByTestId("chat-side-panel-url-viewer")).toContainText(userUrl);
    await expect(page.getByTestId(TEST_IDS.approvalDock)).toHaveCount(0);
    await expect(page.getByTestId("agent-browser-control-resume")).toBeVisible();
    expectStableBrowserBounds(await page.evaluate(() =>
      (window as unknown as { browserGuestGeometry: BrowserGuestGeometry[] }).browserGuestGeometry));
    expect(await readEvents()).toEqual(events);
    expect(errors).toEqual([]);
    expect(await ctx.app.evaluate(() =>
      (globalThis as unknown as { browserFixtureCrashes: unknown[] }).browserFixtureCrashes)).toEqual([]);
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
