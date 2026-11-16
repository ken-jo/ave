/**
 * What a page does while the agent drives it reaches the model with the tool result: a dialog is dismissed and reported,
 * a download is named, and no window-blocking box opens.
 */
import { expect, test } from "@playwright/test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";
import { reviewPage, startReviewSite } from "./browser-review-fixture.js";

type Step = { name: string; args: Record<string, unknown> } | { text: string };
type Plan = (previous: string, all: readonly string[]) => Step;
const MODEL = "browser-page-events-fixture";

/** A model that answers each tool-carrying request with the next step of a fixed plan and records every tool result. */
function plannedModel(plan: readonly Plan[], results: string[]) {
  let index = 0;
  const seen = new Set<string>();
  const stream = (response: ServerResponse, delta: object, finish: string) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "plan", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: MODEL }] })); return; }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown[]; messages?: { role: string; tool_call_id?: string; content: unknown }[] };
    // A request without tools is a side request (a title, a review): it gets a plain answer and does not advance the plan.
    if (!Array.isArray(body.tools) || body.tools.length === 0) { stream(response, { role: "assistant", content: "ok" }, "stop"); return; }
    let previous = "";
    for (const message of body.messages ?? []) {
      if (message.role !== "tool" || message.tool_call_id === undefined || seen.has(message.tool_call_id)) continue;
      seen.add(message.tool_call_id);
      previous = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      results.push(previous);
    }
    const step = plan[index]?.(previous, results) ?? { text: "PLAN COMPLETE" };
    index += 1;
    if ("name" in step) stream(response, { role: "assistant", tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] }, "tool_calls");
    else stream(response, { role: "assistant", content: step.text }, "stop");
  };
}

const PAGE = `<h1>Agent page</h1>
<button onclick="alert('Pay 100 now?'); document.title = 'after-alert'">Show alert</button>
<a href="/file.bin">Download file</a>
<button onclick="fetch('/held').then((r) => r.text()).then(() => { const a = document.createElement('a'); a.href = '/late.bin'; a.download = 'late.bin'; document.body.append(a); a.click(); })">Fetch report</button>`;

test("an agent click that opens a dialog or starts a download says so in its tool result, and opens no native box", async () => {
  test.setTimeout(180_000);
  // The server holds this response until the click's result has reached the model, so the download starts after it.
  let held: ServerResponse | null = null;
  let releaseRequested = false;
  const release = () => { releaseRequested = true; held?.writeHead(200, { "content-type": "text/plain" }).end("ready"); held = null; };
  const site = await startReviewSite((_request, response, url) => {
    if (url.pathname === "/agent") return reviewPage(response, PAGE, "Agent page");
    if (url.pathname === "/held") { held = response; if (releaseRequested) release(); return true; }
    if (url.pathname !== "/file.bin" && url.pathname !== "/late.bin") return false;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${url.pathname === "/late.bin" ? "late.bin" : "report.bin"}"` });
    response.end("data");
    return true;
  });
  const results: string[] = [];
  const tab = (all: readonly string[]) => /"tabId"\s*:\s*"(tab-\d+)"/.exec(all.join("\n"))?.[1];
  const ref = (outline: string, label: string) => new RegExp(`"${label}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(outline)?.[1] ?? "missing";
  const snapshot: Plan = (_previous, all) => ({ name: "browser_snapshot", args: { tabId: tab(all), interactive: true } });
  const plan: Plan[] = [
    () => ({ name: "browser_tab_new", args: { url: `${site.base}/agent` } }),
    snapshot,
    (previous, all) => ({ name: "browser_click", args: { tabId: tab(all), ref: ref(previous, "Show alert") } }),
    snapshot,
    (previous, all) => ({ name: "browser_click", args: { tabId: tab(all), ref: ref(previous, "Download file") } }),
    snapshot,
    (previous, all) => ({ name: "browser_click", args: { tabId: tab(all), ref: ref(previous, "Fetch report") } }),
    (_previous, all) => { release(); return { name: "browser_wait", args: { tabId: tab(all), download: true, timeMs: 20_000 } }; },
  ];
  const answer = plannedModel(plan, results);
  const llm = createServer((request, response) => { void answer(request, response); });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const address = llm.address();
  if (!address || typeof address === "string") throw new Error("the model fixture has no address");
  const settings = buildLlmSettings("openai-compatible", MODEL) as { llm: { vendors: Record<string, { baseUrl?: string }> }; appearance?: Record<string, unknown> };
  const vendor = settings.llm.vendors["openai-compatible"];
  if (!vendor) throw new Error("the settings fixture has no openai-compatible vendor");
  vendor.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  settings.appearance = { ...settings.appearance, language: "en", mode: "light" };
  const context = await launchSeededElectron({ settings, historyRows: [{ role: "user", content: "Page events", createdAt: Date.now() }], sessionTitle: "Page events", launchArgs: ["--disable-gpu"] });
  const { app, page } = context;
  try {
    await setWindowSize(app, 1280, 800, page);
    // Any native message box would be the regression; the system Save dialog is answered by closing it.
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { reviewDialogs: number };
      state.reviewDialogs = 0;
      dialog.showMessageBox = (async () => { state.reviewDialogs += 1; return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
    });
    await page.evaluate(async () => { await (window as unknown as { aveApi: { setApiKey(vendor: string, key: string): Promise<void> } }).aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-page-events"); });
    await page.getByTestId(TEST_IDS.panePanelToggle).click();
    const composer = page.getByTestId("pane-cell:main").getByTestId(TEST_IDS.composerTextarea);
    await composer.fill("Use the fixture page in the browser.");
    await composer.press("Enter");

    // The site approval is answered as a user would; everything else is the plan running.
    let answered = "";
    await expect.poll(async () => {
      const panel = page.getByTestId("tool-approval-panel").first();
      const id = await panel.getAttribute("data-approval-request-id", { timeout: 250 }).catch(() => null);
      if (id && id !== answered) {
        answered = id;
        await panel.getByRole("button", { name: "Allow this site" }).click();
      }
      return page.getByText("PLAN COMPLETE", { exact: true }).first().isVisible();
    }, { timeout: 150_000 }).toBe(true);

    const withDialog = results.find((result) => result.includes('"dismissedDialogs"'));
    expect(withDialog).toBeDefined();
    expect(withDialog).toContain('<browser-content trust="untrusted-web-data">');
    expect(withDialog).toMatch(/"type"\s*:\s*"alert"/);
    expect(withDialog).toContain("Pay 100 now?");
    // The click on the download link reports the download in its own result.
    expect(results[4]).toContain('"downloads"');
    expect(results[4]).toContain('<browser-content trust="untrusted-web-data">');
    expect(results[4]).toContain("report.bin");
    // A download that starts after the click's result is not in that result; waiting for it reports it, with how it ended.
    expect(results[6]).not.toContain("late.bin");
    expect(results[7]).toContain('<browser-content trust="untrusted-web-data">');
    expect(results[7]).toMatch(/"found"\s*:\s*true/);
    expect(results[7]).toMatch(/"name"\s*:\s*"late\.bin"\s*,\s*"state"\s*:\s*"cancelled"/);
    expect(await app.evaluate(() => (globalThis as unknown as { reviewDialogs: number }).reviewDialogs)).toBe(0);
  } finally {
    await teardownSeededElectron(context);
    llm.close();
    site.server.close();
  }
});
