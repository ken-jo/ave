import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("keeps a requested blank tab mounted through its first navigation", async () => {
  let requests = 0;
  let pageRequests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/") pageRequests++;
    response.setHeader("content-type", "text/html");
    response.end('<title>Approved page</title><button>Ready</button><p>Ready again</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({
      settings: buildLlmSettings(),
      historyRows: [{ role: "user", content: "Browser tab fixture", createdAt: Date.now() }],
      sessionTitle: "Browser tab fixture",
      launchArgs: ["--remote-debugging-port=9245", "--disable-gpu"],
    });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.app.evaluate(({ BrowserWindow }, channel) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) throw new Error("Main window unavailable");
      window.webContents.send(channel, { requestId: "browser-op-bootstrap", op: "new", url: "about:blank", active: true });
    }, CHANNELS.browser.tabOp);
    const view = ctx.page.getByTestId("chat-side-panel-browser-webview");
    await expect(view).toHaveAttribute("src", "about:blank");
    const guestId = await view.evaluate((element) => (element as unknown as { getWebContentsId(): number }).getWebContentsId());
    await expect.poll(() => ctx!.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), guestId)).toBe("about:blank");
    expect(requests).toBe(0);
    await expect(view).toHaveAttribute("webpreferences", "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes");
    // This checks renderer continuity; native action fixtures own redirect authorization.
    await ctx.app.evaluate(async ({ webContents }, target) => {
      const guest = webContents.fromId(target.id);
      if (!guest) throw new Error("Guest unavailable");
      await guest.loadURL(target.url);
    }, { id: guestId, url });
    await expect(ctx.page.getByTestId("chat-side-panel-url-viewer")).toContainText(url);
    expect(await view.evaluate((element) => (element as unknown as { getWebContentsId(): number }).getWebContentsId())).toBe(guestId);
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
    await expect(ctx.page.getByTestId("terminal-host-badge")).toHaveText(/^(My terminal \(host\) · No agent access|내 터미널 \(호스트\) · 에이전트 접근 없음)$/u);
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
    expect(await view.evaluate((element) => (element as unknown as { getWebContentsId(): number }).getWebContentsId())).toBe(guestId);
    const screenshot = test.info().outputPath("browser-agent-tab.png");
    await ctx.page.screenshot({ path: screenshot });
    expect(pageRequests).toBe(1);
    await test.info().attach("browser-agent-tab.png", { path: screenshot, contentType: "image/png" });
  } finally {
    if (ctx) await teardownSeededElectron(ctx);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
