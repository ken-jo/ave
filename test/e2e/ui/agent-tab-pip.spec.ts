import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

test.use({ trace: "on" });
for (const width of [1243, 360]) {
  test(`floats real agent tabs over content at ${width}px`, async () => {
    test.setTimeout(120_000);
    const model = "pip-fixture";
    let stage = 0;
    let baseUrl = "";
    let releaseSecond: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const failures: string[] = [];
    const send = (response: ServerResponse, delta: Record<string, unknown>, reason: string | null) => {
      response.write(`data: ${JSON.stringify({ id: "pip", object: "chat.completion.chunk", created: 0, model,
        choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    };
    const tool = (response: ServerResponse, number: number) => {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: `pip-${number}`, type: "function",
        function: { name: "browser_tab_new", arguments: JSON.stringify({ url: `${baseUrl}/page-${number}` }) } }] }, null);
      send(response, {}, "tool_calls"); response.end("data: [DONE]\n\n");
    };
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] })); return;
      }
      if (request.method === "GET" && request.url?.startsWith("/page-")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><title>Agent page ${request.url.slice(-1)}</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%234f70dc'/%3E%3C/svg%3E"><body style="background:#edf3ff;font:24px system-ui;padding:24px"><h1>Agent page ${request.url.slice(-1)}</h1><p>A live browser tab.</p></body>`); return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { role: string; content: unknown }[] };
      const result = body.messages?.findLast((message) => message.role === "tool")?.content;
      if (/"error"\s*:/.test(typeof result === "string" ? result : JSON.stringify(result ?? ""))) failures.push(String(result));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      stage++;
      if (stage === 1) { tool(response, 1); return; }
      if (stage === 2) { releaseSecond = () => tool(response, 2); response.flushHeaders(); return; }
      finish = () => { send(response, { role: "assistant", content: "Browser work complete." }, null); send(response, {}, "stop"); response.end("data: [DONE]\n\n"); };
      response.flushHeaders();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture address missing");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const settings = buildLlmSettings("openai-compatible", model);
    (settings.llm as { vendors: Record<string, { baseUrl: string }> }).vendors["openai-compatible"].baseUrl = `${baseUrl}/v1`;
    let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
    let approving = true;
    let approvals: Promise<void> | undefined;
    try {
      ctx = await launchSeededElectron({ sessionTitle: "Agent tab previews", settings, historyRows: [] });
      await setWindowSize(ctx.app, width, 800);
      const page = ctx.page;
      await page.evaluate(async () => {
        await window.aveApi.setApiKey("openai-compatible", "sk-e2e-pip-loopback");
        const result = await window.ave.permission.setMode("strict");
        if (!result.ok) throw new Error("Strict mode unavailable");
      });
      const pane = page.getByTestId("pane-cell:main");
      const toggle = pane.getByTestId(TEST_IDS.panePanelToggle);
      const closePanel = async () => {
        const close = page.getByTestId("chat-side-panel-close");
        if (await close.isVisible()) await close.click(); else await toggle.click();
      };
      if (await toggle.getAttribute("aria-pressed") === "true") await closePanel();
      const composer = pane.getByTestId("composer-textarea");
      await composer.fill("Open two local pages for the browser task."); await composer.press("Enter");
      approvals = (async () => {
        while (approving) {
          const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
          if (await site.isVisible()) await site.click();
          const toolApproval = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
          if (await toolApproval.isVisible()) await toolApproval.click();
          await page.waitForTimeout(100);
        }
      })();
      await expect.poll(() => releaseSecond !== undefined, { timeout: 60_000 }).toBe(true);
      expect(failures).toEqual([]);
      const cards = page.getByTestId("agent-browser-pip-card");
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toBeVisible();
      await expect(cards.first()).toHaveAttribute("data-compact", String(width < 480));
      if (width >= 480) await expect(cards.getByTestId("browser-observation-preview").locator("img")).toBeVisible({ timeout: 15_000 });
      else await expect(cards.getByTestId("browser-observation-preview")).toHaveCount(0);
      const firstId = await cards.first().getAttribute("data-tab-id");
      const guest = page.locator(`webview[data-tab-id="${firstId}"]`);
      const guestId = await guest.evaluate((element) => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId());
      await toggle.click(); await expect(cards).toHaveCount(0);
      await closePanel(); await expect(cards).toHaveCount(1);
      await cards.getByRole("button", { name: /^(Open browser tab:|브라우저 탭 열기:)/ }).click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("chat-side-panel-url-viewer")).toContainText(`${baseUrl}/page-1`);
      await expect(cards).toHaveCount(0);
      expect(await guest.evaluate((element) => (element as HTMLElement & { getWebContentsId(): number }).getWebContentsId())).toBe(guestId);
      await closePanel(); await expect(cards).toHaveCount(1);
      await cards.getByRole("button", { name: /^(Hide browser preview:|브라우저 미리보기 숨기기:)/ }).click();
      await expect(cards).toHaveCount(0);
      await toggle.click(); await closePanel(); await expect(cards).toHaveCount(1);
      const openSecond = releaseSecond; releaseSecond = undefined; openSecond?.();
      await expect.poll(() => finish !== undefined, { timeout: 30_000 }).toBe(true);
      expect(failures).toEqual([]);
      await expect(cards).toHaveCount(2);
      const boxes = await cards.evaluateAll((elements) => elements.map((element) => {
        const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }));
      expect(boxes[1]?.bottom).toBeLessThanOrEqual(boxes[0]?.top ?? 0);
      for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
      await composer.fill("A follow-up draft");
      const sendButton = pane.getByTestId("composer-send-button");
      await expect(sendButton).toBeEnabled();
      expect(await sendButton.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit === element || element.contains(hit);
      })).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`agent-tab-pip-${width}.png`) });
      if (width >= 480) {
        const target = cards.first().getByRole("button", { name: /^(Open browser tab:|브라우저 탭 열기:)/ });
        const box = await target.boundingBox(); if (!box) throw new Error("Card bounds missing");
        await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
        await page.mouse.move(0, 0, { steps: 8 }); await page.mouse.up();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        const moved = await cards.first().boundingBox();
        expect(moved?.x).toBeGreaterThanOrEqual(0); expect(moved?.y).toBeGreaterThanOrEqual(0);
        expect(moved?.x).toBeLessThan(box.x); expect(moved?.y).toBeLessThan(box.y);
      }
    } finally {
      approving = false;
      releaseSecond?.(); finish?.();
      if (approvals) await approvals.catch(() => {});
      if (ctx) await teardownSeededElectron(ctx);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
