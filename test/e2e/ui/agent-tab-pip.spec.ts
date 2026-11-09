import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

test.use({ trace: "on" });
for (const [width, height] of [[1243, 800], [1243, 600], [360, 800], [360, 600]]) {
  test(`floats real agent tabs below chrome at ${width}×${height}`, async () => {
    test.setTimeout(120_000);
    const model = "pip-fixture";
    let stage = 0;
    let baseUrl = "";
    let releaseActivity: (() => void) | undefined;
    let firstHandle = "";
    let fixtureRoot = "";
    let releaseApproval: (() => void) | undefined;
    let releaseThird: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const failures: string[] = [];
    const send = (response: ServerResponse, delta: Record<string, unknown>, reason: string | null) => {
      response.write(`data: ${JSON.stringify({ id: "pip", object: "chat.completion.chunk", created: 0, model,
        choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    };
    const tool = (response: ServerResponse, number: number, name = "browser_tab_new", args: Record<string, unknown> = { url: `${baseUrl}/page-${number}` }) => {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: `pip-${stage}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] }, null);
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
      if (stage === 2) {
        firstHandle = /"tabId"\s*:\s*"(tab-\d+)"/.exec(typeof result === "string" ? result : JSON.stringify(result))?.[1] ?? "";
        releaseActivity = () => tool(response, 2, "browser_snapshot", { tabId: firstHandle });
        response.flushHeaders(); return;
      }
      if (stage === 3) {
        releaseApproval = () => tool(response, 3, "write_file", { path: `${fixtureRoot}/pip-approval.txt`, content: "Preview approval fixture.\n" });
        response.flushHeaders(); return;
      }
      if (stage === 4) { releaseSecond = () => tool(response, 2); response.flushHeaders(); return; }
      if (stage === 5) releaseThird = () => tool(response, 3);
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
    let holdApproval = false;
    let approvals: Promise<void> | undefined;
    try {
      ctx = await launchSeededElectron({ sessionTitle: "Agent tab previews", settings, historyRows: [] });
      fixtureRoot = ctx.tempHome;
      await setWindowSize(ctx.app, width, height);
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
      await composer.fill("Open three local pages for the browser task."); await composer.press("Enter");
      approvals = (async () => {
        while (approving) {
          const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
          if (await site.isVisible()) await site.click();
          const toolApproval = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
          if (!holdApproval && await toolApproval.isVisible()) await toolApproval.click();
          await page.waitForTimeout(100);
        }
      })();
      await expect.poll(() => releaseActivity !== undefined, { timeout: 60_000 }).toBe(true);
      expect(failures).toEqual([]);
      const cards = page.getByTestId("agent-browser-pip-card");
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toBeVisible();
      await expect(cards.first()).toHaveAttribute("data-compact", String(width < 480));
      if (width >= 480) {
        const image = cards.getByTestId("browser-observation-preview").locator("img");
        await expect(image).toBeVisible({ timeout: 15_000 });
        const picture = await image.evaluate((element) => {
          const image = element as HTMLImageElement; const r = image.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, naturalWidth: image.naturalWidth, fit: getComputedStyle(image).objectFit, position: getComputedStyle(image).objectPosition };
        });
        expect(picture.width).toBeGreaterThan(180);
        expect(picture.width / picture.height).toBeCloseTo(16 / 9, 2);
        expect(picture.naturalWidth).toBeGreaterThan(0); expect(picture.fit).toBe("cover"); expect(picture.position).toBe("0% 0%");
        const badge = await cards.getByText(/^(Live|실시간)$/).boundingBox();
        if (!badge) throw new Error("Live badge bounds missing");
        expect(badge.x).toBeGreaterThanOrEqual(picture.x); expect(badge.y).toBeGreaterThanOrEqual(picture.y);
        expect(badge.x + badge.width).toBeLessThanOrEqual(picture.x + picture.width);
        expect(badge.y + badge.height).toBeLessThanOrEqual(picture.y + picture.height);
      }
      else await expect(cards.getByTestId("browser-observation-preview")).toHaveCount(0);
      const assertControlsClear = async () => {
        for (const controls of [page.getByTestId("main-toolbar").locator("button"), pane.getByTestId("pane-header").locator("button")]) {
          let checked = 0;
          for (const button of await controls.all()) {
            if (!await button.isVisible() || !await button.isEnabled()) continue;
            await expect(button).toBeInViewport();
            expect(await button.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            })).toBe(true);
            await button.click({ trial: true }); checked++;
          }
          expect(checked).toBeGreaterThan(0);
        }
        const body = await pane.locator("[data-pip-region]").boundingBox();
        const reserved = await pane.getByTestId(TEST_IDS.composer).boundingBox();
        if (!body || !reserved) throw new Error("Pane body or composer bounds missing");
        for (const box of await cards.evaluateAll((elements) => elements.map((element) => {
          const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }))) {
          expect(box.top).toBeGreaterThanOrEqual(body.y);
          expect(box.bottom).toBeLessThanOrEqual(reserved.y);
          expect(box.left).toBeGreaterThanOrEqual(body.x); expect(box.right).toBeLessThanOrEqual(body.x + body.width);
        }
        expect(await page.getByTestId("agent-browser-pip-layer").evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
      };
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
      const takeSnapshot = releaseActivity; releaseActivity = undefined; takeSnapshot?.();
      await expect.poll(() => releaseApproval !== undefined, { timeout: 30_000 }).toBe(true);
      expect(firstHandle).toMatch(/^tab-\d+$/);
      await expect(cards).toHaveCount(0);
      await toggle.click();
      await expect(page.locator(`[data-testid="web-surface-frame"][data-tab-id="${firstId}"]`)).toHaveCSS("opacity", "1");
      await closePanel(); await expect(cards).toHaveCount(1);
      holdApproval = true;
      const requestApproval = releaseApproval; releaseApproval = undefined; requestApproval?.();
      const approval = page.getByTestId(TEST_IDS.approvalDock);
      await expect(approval).toBeVisible();
      await expect(page.getByTestId(TEST_IDS.routeCanvas).getByTestId("agent-browser-pip-layer")).toHaveCount(1);
      await expect.poll(async () => {
        const approvalBox = await approval.boundingBox();
        const cardBoxes = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().bottom));
        return approvalBox !== null && cardBoxes.every((bottom) => bottom < approvalBox.y);
      }).toBe(true);
      expect(await approval.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
      await assertControlsClear();
      await page.screenshot({ path: test.info().outputPath(`agent-tab-pip-approval-${width}x${height}.png`) });
      holdApproval = false;
      await expect.poll(() => releaseSecond !== undefined, { timeout: 30_000 }).toBe(true);
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
      await assertControlsClear();
      await page.screenshot({ path: test.info().outputPath(`agent-tab-pip-normal-${width}x${height}.png`) });
      const addThird = releaseThird; releaseThird = undefined; finish = undefined; addThird?.();
      await expect.poll(() => finish !== undefined).toBe(true);
      await expect.poll(async () => {
        const shown = await cards.count();
        const summary = page.getByTestId("agent-browser-pip-overflow");
        const hidden = await summary.count() ? Number((await summary.textContent())?.replace("+", "")) : 0;
        return shown + hidden;
      }).toBe(3);
      await assertControlsClear();
      await page.screenshot({ path: test.info().outputPath(`agent-tab-pip-three-tabs-${width}x${height}.png`) });
      const target = cards.first().getByRole("button", { name: /^(Open browser tab:|브라우저 탭 열기:)/ });
      const box = await target.boundingBox(); if (!box) throw new Error("Card bounds missing");
      await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
      await page.mouse.move(0, 0, { steps: 8 }); await page.mouse.up();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      const moved = await cards.first().boundingBox();
      expect(moved?.x).toBeLessThan(box.x); expect(moved?.y).toBeLessThan(box.y);
      await assertControlsClear();

    } catch (error) {
      if (ctx) {
        await ctx.page.screenshot({ path: test.info().outputPath("failure.png") }).catch(() => {});
      }
      throw error;
    } finally {
      approving = false;
      releaseActivity?.(); releaseApproval?.(); releaseSecond?.(); finish?.();
      if (approvals) await approvals.catch(() => {});
      if (ctx) await teardownSeededElectron(ctx);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("keeps the overflow chip above a native browser guest and opens its first hidden tab", async () => {
  test.setTimeout(120_000);
  const model = "pip-overflow-fixture";
  let stage = 0;
  let baseUrl = "";
  let finish: (() => void) | undefined;
  const failures: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, reason: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "overflow", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] })); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/page-")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Overflow ${request.url}</title><body style="background:#edf3ff;font:24px system-ui"><h1>${request.url}</h1></body>`); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { role: string; content: unknown }[] };
    const result = body.messages?.findLast((message) => message.role === "tool")?.content;
    if (/"error"\s*:/.test(typeof result === "string" ? result : JSON.stringify(result ?? ""))) failures.push(String(result));
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (++stage <= 12) {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: `overflow-${stage}`, type: "function",
        function: { name: "browser_tab_new", arguments: JSON.stringify({ url: `${baseUrl}/page-${stage}` }) } }] }, null);
      send(response, {}, "tool_calls"); response.end("data: [DONE]\n\n"); return;
    }
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
    ctx = await launchSeededElectron({ sessionTitle: "Browser overflow", settings, historyRows: [] });
    await setWindowSize(ctx.app, 1243, 640);
    const page = ctx.page;
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-overflow");
      const result = await window.ave.permission.setMode("strict");
      if (!result.ok) throw new Error("Strict mode unavailable");
    });
    const pane = page.getByTestId("pane-cell:main");
    const composer = pane.getByTestId("composer-textarea");
    await composer.fill("Open twelve local pages."); await composer.press("Enter");
    approvals = (async () => {
      while (approving) {
        const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
        if (await site.isVisible()) await site.click();
        const approval = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
        if (await approval.isVisible()) await approval.click();
        await page.waitForTimeout(100);
      }
    })();
    await expect.poll(() => finish !== undefined, { timeout: 60_000 }).toBe(true);
    expect(failures).toEqual([]);
    const created = await page.evaluate(async (url) => (await window.aveApi.browserTabs?.getState())?.tabs
      .filter((tab) => tab.url.startsWith(url)).map((tab) => ({ id: tab.rendererTabId, page: Number(tab.url.split("page-")[1]) })) ?? [], baseUrl);
    expect(created).toHaveLength(12);
    const movedId = created.find((tab) => tab.page === 12)?.id;
    if (!movedId) throw new Error("Main browser target missing");
    await pane.getByTestId(TEST_IDS.panePanelToggle).click();
    await pane.getByTestId("pane").evaluate((element, id) => {
      const rect = element.getBoundingClientRect(); const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-ave-surface", JSON.stringify({ tabId: id, kind: "browser", from: { side: "main" } }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer, clientX: rect.right - 2, clientY: rect.top + rect.height / 2 }));
    }, movedId);
    const mainGuest = page.locator(`[data-testid="web-surface-frame"][data-tab-id="${movedId}"]`);
    await expect(mainGuest).toHaveCSS("opacity", "1");
    const overflow = page.getByTestId("agent-browser-pip-overflow");
    const assertHitArea = async () => {
      await expect(overflow).toBeVisible();
      await expect.poll(() => overflow.evaluate((button) => {
        const r = button.getBoundingClientRect();
        const points = [3, r.height / 2, r.height - 3].flatMap((y) => [8, r.width / 2, r.width - 8].map((x) => [r.left + x, r.top + y] as const));
        return points.every(([x, y]) => button.contains(document.elementFromPoint(x, y)));
      })).toBe(true);
    };
    await assertHitArea();
    const guestBounds = await mainGuest.boundingBox(); const chipBounds = await overflow.boundingBox();
    if (!guestBounds || !chipBounds) throw new Error("Overflow geometry missing");
    expect(chipBounds.y + chipBounds.height).toBeGreaterThan(guestBounds.y);
    await page.screenshot({ path: test.info().outputPath("agent-tab-pip-overflow-1243x640.png") });
    await setWindowSize(ctx.app, 1243, 720); await assertHitArea();
    await setWindowSize(ctx.app, 1243, 640); await assertHitArea();
    const shown = new Set(await page.getByTestId("agent-browser-pip-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-tab-id"))));
    const visible = new Set(await page.getByTestId("web-surface-frame").evaluateAll((frames) => frames.filter((frame) => {
      const style = getComputedStyle(frame); return style.visibility === "visible" && style.opacity === "1";
    }).map((frame) => frame.getAttribute("data-tab-id"))));
    const hidden = created.sort((a, b) => b.page - a.page).filter((tab) => !shown.has(tab.id) && !visible.has(tab.id));
    expect(await overflow.textContent()).toBe(`+${hidden.length}`);
    const expectedId = hidden[0]?.id;
    if (!expectedId) throw new Error("First hidden tab missing");
    const box = await overflow.boundingBox(); if (!box) throw new Error("Overflow bounds missing");
    const point = { x: box.x + box.width / 2, y: box.y + box.height - 3 };
    const underlying = await mainGuest.boundingBox(); if (!underlying) throw new Error("Native guest bounds missing");
    expect(point.x).toBeGreaterThan(underlying.x); expect(point.x).toBeLessThan(underlying.x + underlying.width);
    expect(point.y).toBeGreaterThan(underlying.y); expect(point.y).toBeLessThan(underlying.y + underlying.height);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(`[data-testid="web-surface-frame"][data-tab-id="${expectedId}"]`)).toHaveCSS("opacity", "1");
  } finally {
    approving = false; finish?.();
    if (approvals) await approvals.catch(() => {});
    if (ctx) await teardownSeededElectron(ctx);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
