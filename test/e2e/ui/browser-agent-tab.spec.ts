import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import { browserHostIdentity, browserTargetId, inspectBrowserTarget } from "./browser-native-target.js";

// Main names the owning conversation on every agent tab it opens; the renderer refuses an unowned one.
const SESSION_ID = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";

test("keeps an agent page mounted through blank bootstrap and first navigation", async () => {
  let pageRequests = 0;
  let firstPageRequestAt = 0;
  let modelRequests = 0;
  let url = "";
  const toolResults: string[] = [];
  const model = "browser-bootstrap-fixture";
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const output = body.messages?.findLast((message: { role: string }) => message.role === "tool")?.content ?? "";
      if (modelRequests > 0) toolResults.push(String(output));
      const tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(String(output))?.[1];
      modelRequests++;
      const tool = modelRequests === 1 ? { name: "browser_tab_new", args: { url } }
        : modelRequests === 2 ? { name: "browser_tabs", args: { select: tabId } } : undefined;
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `bootstrap-${modelRequests}`, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
        : { role: "assistant", content: "Blank browser ready." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "bootstrap", object: "chat.completion.chunk", created: 0, model,
        choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (request.url === "/") { pageRequests++; firstPageRequestAt ||= Date.now(); }
    response.setHeader("content-type", "text/html");
    response.end('<title>Approved page</title><button>Ready</button><p>Ready again</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  url = `http://127.0.0.1:${address.port}/`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `${url}v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({
      settings,
      historyRows: [{ role: "user", content: "Browser tab fixture", createdAt: Date.now() }],
      sessionTitle: "Browser tab fixture",
      sessionId: SESSION_ID,
      launchArgs: ["--disable-gpu"],
    });
    const host = await browserHostIdentity(ctx.app, ctx.page);
    await ctx.app.evaluate(({ app }) => {
      const state = globalThis as unknown as { blankBootstraps: { id: number; at: number }[] };
      state.blankBootstraps = [];
      app.on("web-contents-created", (_event, contents) => {
        contents.on("did-finish-load", () => {
          if (contents.getURL() === "about:blank") state.blankBootstraps.push({ id: contents.id, at: Date.now() });
        });
      });
    });
    await ctx.page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-browser-bootstrap");
      const mode = await window.ave.permission.setMode("allow");
      if (!mode.ok) throw new Error("Bootstrap permission mode unavailable");
      const reviewer = await window.ave.permission.reviewerDispatch("mode disabled");
      if (!reviewer.ok) throw new Error("Bootstrap permission reviewer unavailable");
    });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    const composer = ctx.page.getByTestId("pane-cell:main").getByTestId(TEST_IDS.composerTextarea);
    await composer.fill("Create the fixture browser tab and select it.");
    await composer.press("Enter");
    await ctx.page.getByTestId("browser-site-approval-card")
      .getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).click();
    await expect(ctx.page.getByText("Blank browser ready.", { exact: true })).toBeVisible();
    expect(toolResults).toHaveLength(2);
    expect(toolResults.some(result => /"error"\s*:/.test(result))).toBe(false);
    const guestId = await browserTargetId(ctx.app, url);
    await expect.poll(async () => (await inspectBrowserTarget(ctx!.app, host.windowId, url)).attached).toBe(true);
    const bootstraps = await ctx.app.evaluate((_main, id) =>
      (globalThis as unknown as { blankBootstraps: { id: number; at: number }[] }).blankBootstraps.filter(entry => entry.id === id), guestId);
    expect(bootstraps).toHaveLength(1);
    const [bootstrap] = bootstraps;
    if (!bootstrap) throw new Error("Native page blank bootstrap unavailable");
    expect(bootstrap.at).toBeLessThanOrEqual(firstPageRequestAt);
    expect(pageRequests).toBe(1);
    const preferences = await ctx.app.evaluate(({ webContents }, id) => {
      const target = webContents.fromId(id);
      if (!target || !("getLastWebPreferences" in target) || typeof target.getLastWebPreferences !== "function") {
        throw new Error("Native page preferences unavailable");
      }
      return target.getLastWebPreferences();
    }, guestId);
    expect(preferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    expect(await inspectBrowserTarget(ctx.app, host.windowId, url)).toMatchObject({ id: guestId, type: "window", embedded: false });
    await expect(ctx.page.getByTestId("chat-side-panel-url-viewer")).toContainText(url);
    expect(await browserTargetId(ctx.app, url)).toBe(guestId);
    // The shipping preload/IPC/native guest must agree with the visible chrome.
    await ctx.page.getByTestId("browser-workspace-toggle").click();
    const workspace = ctx.page.getByTestId("browser-workspace-panel");
    await expect(workspace).toBeVisible();
    await workspace.getByRole("button", { name: /^(Bookmark|북마크)$/ }).click();
    await expect.poll(() => ctx!.page.evaluate(async () => {
      const state = await window.aveApi.browserWorkspace!.getState();
      return state.ok ? state.value.bookmarks.map((entry) => entry.url) : [];
    })).toContain(url);
    await workspace.getByRole("combobox", { name: /^(Zoom|확대)$/ }).selectOption("1.25");
    await expect.poll(() => ctx!.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor(), guestId)).toBe(1.25);
    await workspace.getByRole("textbox", { name: /^(Find|찾기)$/ }).fill("Ready");
    await workspace.getByRole("button", { name: /^(Find|찾기)$/ }).click();
    await expect(workspace.getByRole("alert")).toHaveCount(0);
    await workspace.getByRole("button", { name: /^(Library|라이브러리)$/ }).click();
    await expect(workspace.locator("img")).toHaveCount(1, { timeout: 15_000 });
    await ctx.page.getByTestId("browser-workspace-toggle").click();
    await expect(workspace).toHaveCount(0);
    // Opening the host terminal retains the browser's actual guest instance.
    await ctx.page.getByTestId("chat-side-panel-add-tab").click();
    await ctx.page.getByTestId("chat-side-panel-launcher-menu-terminal").click();
    await expect(ctx.page.getByTestId("chat-side-panel-pty-terminal").getByTestId("terminal-pane-host-chip")).toHaveText(/^(Host · no agent access|호스트 · 에이전트 접근 없음)$/u);
    await expect(ctx.page.getByTestId("chat-side-panel-pty-terminal").locator(".xterm")).toBeVisible();
    const terminalTabId = await ctx.page.getByTestId("chat-side-panel-tab-terminal").evaluate((element) => element.closest("[data-tab-id]")?.getAttribute("data-tab-id"));
    if (!terminalTabId) throw new Error("Visible terminal identity unavailable");
    const manual = await ctx.page.evaluate(async (tabId) => {
      const api = window.aveApi.terminal!;
      const spawned = await api.spawn({ tabId, lane: "manual", purpose: "workspace" });
      if (!spawned.ok) throw new Error(spawned.message);
      const session = spawned.session;
      const output = await new Promise<string>((resolve, reject) => {
        let observed = "";
        const timeout = setTimeout(() => { off(); reject(new Error("Manual shell output unavailable")); }, 5_000);
        const off = api.onData((event) => {
          if (event.tabId !== tabId || event.lane !== "manual" || event.terminalSessionId !== session.terminalSessionId) return;
          observed += event.chunk;
          if (observed.includes("AVE_MANUAL_PROBE")) { clearTimeout(timeout); off(); resolve(observed); }
        });
        // The contiguous result is absent from the echoed command itself.
        void api.input(session, "printf 'AVE_%s\\n' MANUAL_PROBE\r").then((result) => {
          if (!result.ok) { clearTimeout(timeout); off(); reject(new Error(result.error)); }
        }, (error) => { clearTimeout(timeout); off(); reject(error); });
      });
      return { substrate: session.substrate, replayed: spawned.replayed, output };
    }, terminalTabId);
    expect(manual.substrate).toBe("host");
    expect(manual.replayed).toBe(true);
    expect(manual.output).toContain("AVE_MANUAL_PROBE");
    expect(await browserTargetId(ctx.app, url)).toBe(guestId);
    expect(await inspectBrowserTarget(ctx.app, host.windowId, url)).toMatchObject({ id: guestId, attached: false });
    const screenshot = test.info().outputPath("browser-agent-tab.png");
    await ctx.page.screenshot({ path: screenshot });
    expect(pageRequests).toBe(1);
    await test.info().attach("browser-agent-tab.png", { path: screenshot, contentType: "image/png" });
  } finally {
    if (ctx) await teardownSeededElectron(ctx);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
