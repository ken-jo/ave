import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test.use({ trace: "on" });
const DOCUMENT_FIXTURES = [
  { name: "usable document", title: "Usable document", marker: "", vendor: undefined },
  { name: "waiting interstitial", title: "잠시만 기다리십시오…", marker: "", vendor: "cloudflare" },
  { name: "embedded verification", title: "Verification", marker: '<iframe src="https://geo.captcha-delivery.com/captcha/fixture"></iframe>', vendor: "datadome" },
  { name: "verification dialog", title: "Verification", marker: '<div id="px-captcha" role="dialog"></div>', vendor: "perimeterx" },
  { name: "security container", title: "Verification", marker: '<div id="sec-cpt-container"></div>', vendor: "akamai" },
] as const;

for (const fixture of DOCUMENT_FIXTURES) test(`returns main-document readiness and challenge metadata: ${fixture.name}`, async () => {
  test.setTimeout(75_000);
  const model = "document-readiness-fixture";
  const measurements: Array<{ tool: string; elapsedMs: number; header: Record<string, unknown>; output: string }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let baseUrl = "";
  let issuedTool = "";
  let issuedAt = 0;
  let stage = 0;
  const respond = (response: ServerResponse, tool?: { name: string; args: Record<string, unknown> }) => {
    if (tool) { issuedTool = tool.name; issuedAt = Date.now(); }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `readiness-${stage}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: "assistant", content: "Usable document confirmed." };
    response.end(`data: ${JSON.stringify({ id: "readiness", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] })); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/held-image")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.flushHeaders();
      const timer = setTimeout(() => { timers.delete(timer); response.end(); }, 6_000);
      timers.add(timer); return;
    }
    if (request.method === "GET" && request.url?.startsWith("/document")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta http-equiv="Content-Security-Policy" content="frame-src 'none'"><title>${fixture.title}</title>${fixture.marker}<h1>Usable document</h1><button>Ready control</button><img src="/held-image?${encodeURIComponent(request.url)}">`); return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    const content = body.messages?.findLast(message => message.role === "tool")?.content;
    const output = typeof content === "string" ? content : JSON.stringify(content ?? "");
    let header: Record<string, unknown> = {};
    if (issuedTool) {
      try { header = JSON.parse(output.split("\n")[2] ?? "{}"); } catch { header = { invalidResult: output }; }
      measurements.push({ tool: issuedTool, elapsedMs: Date.now() - issuedAt, header, output });
    }
    stage++;
    if (stage === 1) respond(response, { name: "browser_tab_new", args: { url: `${baseUrl}/document?opened` } });
    else if (stage === 2) respond(response, { name: "browser_navigate", args: { tabId: header.tabId, url: `${baseUrl}/document?navigated` } });
    else if (stage === 3) respond(response, { name: "browser_snapshot", args: { tabId: header.tabId, interactive: true } });
    else respond(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Readiness fixture address unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `${baseUrl}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  let approving = true;
  let approvals: Promise<void> | undefined;
  try {
    ctx = await launchSeededElectron({ settings, sessionTitle: "Document readiness", historyRows: [] });
    const { page } = ctx;
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-readiness");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Strict approval unavailable");
    });
    const composer = page.getByTestId("pane-cell:main").getByTestId("composer-textarea");
    await composer.fill("Open the document, navigate again and snapshot its ready control.");
    await composer.press("Enter");
    approvals = (async () => {
      while (approving) {
        const site = page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).first();
        if (await site.isVisible()) await site.click();
        const action = page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first();
        if (await action.isVisible()) await action.click();
        await page.waitForTimeout(100);
      }
    })();
    await expect(page.getByTestId("chat-main-column").getByText("Usable document confirmed.", { exact: true })).toBeVisible({ timeout: 60_000 });
    const guest = await ctx.app.evaluate(({ webContents }, url) => {
      const targets = webContents.getAllWebContents().filter(contents => contents.getURL() === url);
      if (targets.length !== 1) throw new Error(`Expected one readiness target, found ${targets.length}`);
      const page = targets[0]!;
      return { url: page.getURL(), loading: page.isLoading(), title: page.getTitle(), type: page.getType(), embedded: Boolean(page.hostWebContents) };
    }, `${baseUrl}/document?navigated`);
    console.log("Native document readiness measurements", JSON.stringify({ measurements, guest }));
    await test.info().attach("document-readiness.json", { body: JSON.stringify({ measurements, guest }, null, 2), contentType: "application/json" });
    expect(measurements.map(row => row.tool)).toEqual(["browser_tab_new", "browser_navigate", "browser_snapshot"]);
    for (const row of measurements.slice(0, 2)) {
      expect(row.header).not.toHaveProperty("error");
      expect(row.header).not.toHaveProperty("loading");
      expect(row.elapsedMs).toBeLessThan(5_500);
    }
    expect(measurements[2]?.output).toContain("Ready control");
    for (const row of measurements) {
      expect(row.output).toMatch(/^<browser-content trust="untrusted-web-data">/);
      expect(row.output).toMatch(/<\/browser-content>$/);
      if (fixture.vendor) expect(row.header.challenge).toEqual({ vendor: fixture.vendor, hint: "The user can solve it in the web panel." });
      else expect(row.header).not.toHaveProperty("challenge");
    }
    expect(guest).toMatchObject({ url: `${baseUrl}/document?navigated`, loading: true, title: fixture.title, type: "window", embedded: false });
    await expect(page.getByTestId(TEST_IDS.panePanelToggle)).toHaveAttribute("aria-pressed", "false");
  } finally {
    approving = false;
    try { if (approvals) await approvals; }
    finally {
      try { if (ctx) await teardownSeededElectron(ctx, { terminate: true }); }
      finally {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  }
});
