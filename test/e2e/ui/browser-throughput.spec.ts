import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { estimateTokens } from "../../../src/shared/token-estimate.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test.use({ trace: "on" });
const OBSERVATION_MODES: readonly ("wait" | "iframe" | "snapshot")[] = ["wait", "iframe", "snapshot"];
for (const mode of OBSERVATION_MODES) test(`keeps five parked ${mode} observations within one useful model round`, async () => {
  test.setTimeout(120_000);
  const model = "browser-throughput-fixture";
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const observed: Array<{ phase: string; elapsedMs: number; results: Array<{ id: string; text: string; header: Record<string, unknown>; tokens: number }> }> = [];
  let baseUrl = "";
  let stage = 0;
  let phase = "open";
  let issuedAt = 0;
  let recoveryCalls = 0;
  const pendingRecovery: string[] = [];
  const respond = (response: ServerResponse, tools?: Array<{ name: string; args: Record<string, unknown> }>) => {
    issuedAt = Date.now();
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const delta = tools ? { role: "assistant", tool_calls: tools.map((tool, index) => ({ index, id: `throughput-${stage}-${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }
      : { role: "assistant", content: "Five useful observations confirmed." };
    response.end(`data: ${JSON.stringify({ id: "throughput", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] })); return;
    }
    if (request.method === "GET" && (request.url?.startsWith("/held-image") || request.url?.startsWith("/held-frame"))) {
      response.writeHead(200, { "content-type": "image/png" }); response.flushHeaders();
      const timer = setTimeout(() => { timers.delete(timer); response.end(); }, request.url?.startsWith("/held-frame") ? 5_000 : 1_500); timers.add(timer); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/article/")) { response.writeHead(200, { "content-type": "text/html" }).end("<h1>Article loaded</h1>"); return; }
    if (request.method === "GET" && request.url?.startsWith("/page")) {
      const number = new URL(request.url, "http://fixture.invalid").searchParams.get("number") ?? "0";
      const links = mode === "snapshot" ? Array.from({ length: 650 + Number(number) * 70 }, (_, index) => `<a href="/article/${index}">News item ${index}: A descriptive regional headline covering public affairs and important developments</a><p>Supporting details for report ${index} with context and a repeated navigation wrapper.</p>`).join("") : "";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>News fixture ${number}</title><h1>Lead headline for fixture ${number}</h1><button>Ready control</button>${links}${mode === "wait" ? '<img src="/held-image">' : mode === "iframe" ? '<script>addEventListener("load", () => setTimeout(() => { const frame = document.createElement("iframe"); frame.src = "/held-frame"; document.body.append(frame); }, 0));</script>' : ''}`); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown; tool_call_id?: string }> };
    const messages = body.messages ?? [];
    const assistantIndex = messages.findLastIndex(message => message.role === "assistant");
    const results = messages.slice(assistantIndex + 1).filter(message => message.role === "tool").map(message => {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      let header: Record<string, unknown> = {}; try { header = JSON.parse(text.split("\n")[2] ?? "{}"); } catch { /* A generic host stub has no browser header. */ }
      return { id: message.tool_call_id ?? "", text, header, tokens: estimateTokens(text) };
    });
    if (stage > 0) observed.push({ phase, elapsedMs: Date.now() - issuedAt, results });
    stage++;
    if (stage === 1) { respond(response, Array.from({ length: 5 }, (_, index) => ({ name: "browser_tab_new", args: { url: `${baseUrl}/page?number=${index}` } }))); return; }
    if (stage === 2) {
      phase = mode;
      respond(response, results.map(result => ({ name: mode !== "snapshot" ? "browser_wait" : "browser_snapshot", args: { tabId: result.header.tabId, ...(mode !== "snapshot" ? { timeMs: 2_000 } : {}) } }))); return;
    }
    if (stage === 3 && mode === "snapshot") pendingRecovery.push(...results.filter(result => /tool_result truncated by host/.test(result.text)).map(result => result.id));
    if (stage === 3 && mode === "snapshot" && pendingRecovery.length === 0) {
      phase = "continuation";
      respond(response, [{ name: "browser_snapshot", args: { tabId: results[0]?.header.tabId, offset: results[0]?.header.nextOffset, delta: false } }]); return;
    }
    if (phase === "continuation" && stage > 3) {
      const ref = results[0]?.text.match(/\[ref=(e\d+)\]/)?.[1];
      phase = "click";
      respond(response, [{ name: "browser_click", args: { tabId: results[0]?.header.tabId, ref } }]); return;
    }
    if (pendingRecovery.length) {
      phase = "recovery"; recoveryCalls++;
      respond(response, [{ name: "read_tool_result_chunk", args: { toolUseId: pendingRecovery.shift(), maxChars: 3_000 } }]); return;
    }
    respond(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Throughput fixture unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `${baseUrl}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  let approving = true;
  let approvals: Promise<void> | undefined;
  try {
    ctx = await launchSeededElectron({ settings, sessionTitle: "Browser throughput", historyRows: [] });
    const { page } = ctx;
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-throughput");
      const mode = await window.ave.permission.setMode("strict"); if (!mode.ok) throw new Error("Strict approval unavailable");
    });
    const composer = page.getByTestId("pane-cell:main").getByTestId("composer-textarea");
    await composer.fill("Open five pages and obtain useful observations without unnecessary waiting or generic recovery."); await composer.press("Enter");
    approvals = (async () => {
      while (approving) {
        const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
        if (await site.isVisible()) await site.click();
        const action = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
        if (await action.isVisible()) await action.click();
        await page.waitForTimeout(100);
      }
    })();
    await expect(page.getByTestId("chat-main-column").getByText("Five useful observations confirmed.", { exact: true })).toBeVisible({ timeout: 90_000 });
    const loadingStates = mode === "iframe" ? await ctx.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getType() === "webview").map(contents => ({ pageLoading: contents.isLoading(), mainLoading: contents.isLoadingMainFrame() }))) : [];
    if (mode === "iframe") expect(loadingStates.some(state => state.pageLoading && !state.mainLoading)).toBe(true);
    const metrics = { mode, loadingStates, phases: observed.map(row => ({ phase: row.phase, elapsedMs: row.elapsedMs, results: row.results.map(({ id, header, tokens, text }) => ({ id, header, tokens, hostTruncated: /tool_result truncated by host/.test(text), chars: text.length })) })), recoveryCalls };
    console.log("Native throughput measurements", JSON.stringify(metrics));
    await test.info().attach("browser-throughput.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
    const observations = observed.find(row => row.phase === mode); expect(observations?.results).toHaveLength(5);
    if (mode !== "snapshot") {
      expect(observations?.elapsedMs).toBeLessThan(3_000);
      for (const result of observations?.results ?? []) expect(result.header).toMatchObject({ reason: "load-complete", loading: false });
    } else {
      expect(recoveryCalls).toBe(0);
      expect(observed.find(row => row.phase === "continuation")?.results[0]?.header.offset).toBeGreaterThan(0);
      expect(observed.find(row => row.phase === "click")?.results[0]?.header.url).toMatch(/\/article\//);
      for (const result of observations?.results ?? []) {
        expect(result.text).toMatch(/^<browser-content trust="untrusted-web-data">/);
        expect(result.text).toContain("Lead headline for fixture");
        expect(result.tokens).toBeLessThanOrEqual(2_000);
        expect(result.header.nextOffset).toBeGreaterThan(0);
      }
    }
    await expect(page.getByTestId(TEST_IDS.panePanelToggle)).toHaveAttribute("aria-pressed", "false");
  } finally {
    approving = false;
    try { if (approvals) await approvals; }
    finally { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (ctx) await teardownSeededElectron(ctx, { terminate: true }); }
  }
});
