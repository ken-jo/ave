import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("keeps a requested blank tab mounted through its first navigation", async () => {
  const legacyHome = mkdtempSync(join(tmpdir(), "ave-browser-tab-legacy-"));
  let requests = 0;
  let pageRequests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/") pageRequests++;
    response.setHeader("content-type", "text/html");
    response.end('<title>Approved page</title><button>Ready</button>');
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
      launchEnv: { AVE_HOME: legacyHome },
      launchArgs: ["--remote-debugging-port=9245", "--disable-gpu"],
    });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.app.evaluate(({ BrowserWindow }, channel) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) throw new Error("Main window unavailable");
      window.webContents.send(channel, { requestId: "browser-op-bootstrap", op: "new", url: "about:blank" });
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
    const screenshot = test.info().outputPath("browser-agent-tab.png");
    await ctx.page.screenshot({ path: screenshot });
    expect(pageRequests).toBe(1);
    await test.info().attach("browser-agent-tab.png", { path: screenshot, contentType: "image/png" });
  } finally {
    if (ctx) await teardownSeededElectron(ctx);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(legacyHome, { recursive: true, force: true });
  }
});
