import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { expect } from "@playwright/test";
import { buildLlmSettings, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";
import { browserHostIdentity, browserTargetId, inspectBrowserTarget } from "./browser-native-target.js";
import { admitFixturePlugins } from "./admit-fixture-plugins.js";
import { SUGGESTIONS_SESSION_ID } from "../../../src/shared/suggestions-session.js";

export async function launchUiLayerFixture(width: number, options: {
  prepareHome?: (aveHome: string) => void | Promise<void>;
  admitPreparedPlugins?: boolean;
  fallbackNotice?: boolean;
  suggestions?: boolean;
} = {}) {
  const model = "native-ui-layer-fixture";
  const fallbackModel = "native-ui-layer-backup";
  let fallbackPending = false;
  let url = "";
  let phase = 0;
  let tabId = "";
  let buttonRef = "";
  let releaseClick: (() => void) | undefined;
  let finish: (() => void) | undefined;
  let continuation: ((name: string, args: Record<string, unknown>) => void) | undefined;
  let clicked = false;
  const heldResponses = new Set<ServerResponse>();
  let nextTurnReceipt = 0;
  let dispatchedTurnReceipt = 0;
  let queuedTurn: { receipt: number; name: string; args: Record<string, unknown> } | undefined;
  const results: string[] = [];
  const respond = (response: ServerResponse, name?: string, args?: Record<string, unknown>) => {
    heldResponses.delete(response);
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `ui-layer-${phase}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "Native UI task complete." };
    response.end(`data: ${JSON.stringify({ id: "ui-layer", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const completeHeldResponses = () => {
    for (const response of heldResponses) respond(response);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Native UI fixture</title>
        <style>html,body{margin:0;background:rgb(180,0,200);font:20px sans-serif}body{height:2600px}button,input{position:absolute;left:24px;box-sizing:border-box}button{top:80px;width:180px;height:48px}input{top:160px;width:220px;height:44px}</style>
        <button id="action">Page action</button><input id="editor" aria-label="Page editor"><script>
        window.fixtureState={clicks:0,trusted:false,activation:false,wheels:0,keys:[],value:"",heldMoves:0,unsolicitedUps:0,pageDown:false};
        document.getElementById('action').onclick=event=>{fixtureState.clicks++;fixtureState.trusted=event.isTrusted;fixtureState.activation=navigator.userActivation.isActive};
        addEventListener('wheel',event=>{if(event.isTrusted)fixtureState.wheels++});
        addEventListener('keydown',event=>fixtureState.keys.push(event.key));
        addEventListener('mousedown',()=>{fixtureState.pageDown=true});
        addEventListener('mousemove',event=>{if(event.buttons&&!fixtureState.pageDown)fixtureState.heldMoves++});
        addEventListener('mouseup',()=>{if(!fixtureState.pageDown)fixtureState.unsolicitedUps++;fixtureState.pageDown=false});
        document.getElementById('editor').oninput=event=>{fixtureState.value=event.target.value;fixtureState.inputTrusted=event.isTrusted};
        </script>`);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [model, ...(options.fallbackNotice ? [fallbackModel] : [])].map(id => ({ id })) }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (fallbackPending && body.model === model) {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "0" }).end(JSON.stringify({
        error: { message: "Model temporarily unavailable" },
      }));
      return;
    }
    if (body.model === fallbackModel) fallbackPending = false;
    const content = body.messages?.findLast((message: { role: string }) => message.role === "tool")?.content;
    const output = typeof content === "string" ? content : JSON.stringify(content ?? "");
    if (phase > 0) results.push(output);
    phase++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (queuedTurn) {
      const next = queuedTurn;
      queuedTurn = undefined;
      dispatchedTurnReceipt = next.receipt;
      respond(response, next.name, next.args);
    } else if (options.fallbackNotice && body.model === fallbackModel) respond(response);
    else if (phase === 1) respond(response, "browser_tab_new", { url });
    else if (phase === 2) {
      tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(output)?.[1] ?? "";
      respond(response, "browser_snapshot", { tabId, interactive: true });
    } else if (phase === 3) {
      buttonRef = /button "Page action"[^\n]*\[ref=(e\d+)\]/.exec(output)?.[1] ?? "";
      releaseClick = () => respond(response, "browser_click", { tabId, ref: buttonRef });
      heldResponses.add(response);
      response.flushHeaders();
    } else {
      clicked = true;
      finish = () => respond(response);
      continuation = (name, args) => respond(response, name, args);
      heldResponses.add(response);
      response.flushHeaders();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/page`;
  const settings = buildLlmSettings("openai-compatible", model);
  if (options.fallbackNotice) {
    const llm = settings.llm;
    assert(llm && typeof llm === "object" && !Array.isArray(llm));
    settings.llm = { ...llm, fallbackChain: [{ provider: "openai-compatible", model: fallbackModel }] };
  }
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl = `http://127.0.0.1:${address.port}/v1`;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({ settings, sessionTitle: "Native UI composition", historyRows: [], prepareHome: options.prepareHome,
      sessionId: options.suggestions ? SUGGESTIONS_SESSION_ID : undefined });
    if (options.admitPreparedPlugins) {
      const admitted = await admitFixturePlugins({ ...ctx, mainWindow: ctx.page });
      ctx = { ...ctx, app: admitted.app, page: admitted.mainWindow };
    }
    const { app, page } = ctx;
    if (options.suggestions) await page.getByTestId(`sidebar-session-${SUGGESTIONS_SESSION_ID}`).click();
    await setWindowSize(app, width, 800);
    const host = await browserHostIdentity(app, page);
    expect(await app.evaluate(({ webContents, session }, id) => {
      const chrome = webContents.fromId(id);
      if (!chrome) throw new Error("App UI contents unavailable");
      return { type: chrome.getType(), defaultSession: chrome.session === session.defaultSession };
    }, host.chromeId)).toEqual({ type: "window", defaultSession: true });
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-native-ui-layer");
      const mode = await window.ave.permission.setMode("allow");
      if (!mode.ok) throw new Error("UI fixture permission mode unavailable");
      const review = await window.ave.permission.reviewerDispatch("mode disabled");
      if (!review.ok) throw new Error("UI fixture reviewer mode unavailable");
    });
    const composer = page.getByTestId("pane-cell:main").getByTestId("composer-textarea");
    await composer.fill("Open the fixture page and prepare its Page action.");
    await composer.press("Enter");
    await page.getByTestId("browser-site-approval-card").getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ }).click();
    await expect.poll(() => releaseClick !== undefined).toBe(true);
    assert.match(buttonRef, /^e\d+$/);
    const toggle = page.getByTestId("pane-panel-toggle");
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
    await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).attached).toBe(true);
    const targetId = await browserTargetId(app, url);
    const control = () => page.evaluate(async target => {
      const tabs = window.aveApi.browserTabs;
      if (!tabs) throw new Error("UI fixture browser control unavailable");
      const control = (await tabs.getState()).tabs.find(tab => tab.tabId === target);
      if (!control) throw new Error("UI fixture browser control target unavailable");
      return control;
    }, tabId);
    const initialControl = await control();
    assert(initialControl.rendererTabId);
    const rendererTabId = initialControl.rendererTabId;
    const readPage = () => app.evaluate(async ({ webContents }, id) => {
      const target = webContents.fromId(id);
      if (!target) throw new Error("UI fixture page unavailable");
      return target.executeJavaScript("({...window.fixtureState,scrollY})");
    }, targetId);
    return {
      app, page, host, url, targetId, rendererTabId, composer, control, readPage,
      toolReady: () => continuation !== undefined,
      toolResults: () => [...results],
      queueNextTurnTool: (name: string, args: Record<string, unknown>) => {
        assert(!queuedTurn, "A fixture turn is already queued");
        const receipt = ++nextTurnReceipt;
        queuedTurn = { receipt, name, args };
        continuation = undefined;
        finish = undefined;
        return receipt;
      },
      nextTurnDispatched: () => dispatchedTurnReceipt,
      clickFromAgent: async () => {
        assert(releaseClick);
        releaseClick();
        releaseClick = undefined;
        await expect.poll(() => clicked).toBe(true);
        expect(results.some(result => /"error"\s*:/.test(result))).toBe(false);
      },
      requestTool: (name: string, args: Record<string, unknown>) => {
        assert(continuation, "The prior browser tool must finish before the next fixture tool");
        continuation(name, args);
        continuation = undefined;
        finish = undefined;
      },
      requestPageClick: () => {
        assert(continuation, "The prior fixture tool must finish before clicking the page");
        continuation("browser_click", { tabId, ref: buttonRef });
        continuation = undefined;
        finish = undefined;
      },
      finishTurn: async () => {
        assert(finish, "The fixture must hold a model response before finishing the turn");
        finish();
        finish = undefined;
        continuation = undefined;
        await expect(page.getByRole("button", { name: /^(LLM 취소|Cancel LLM)/ })).toHaveCount(0);
      },
      startFallbackTurn: async () => {
        assert(options.fallbackNotice, "The fixture must configure a fallback model");
        assert(finish, "The fixture must hold a model response before starting a new turn");
        finish();
        continuation = undefined;
        finish = undefined;
        await expect(page.getByRole("button", { name: /^(LLM 취소|Cancel LLM)/ })).toHaveCount(0);
        fallbackPending = true;
        await composer.fill("Continue with the configured backup model and retain the browser page.");
        await composer.press("Enter");
      },
      close: async () => {
        completeHeldResponses();
        if (ctx) await teardownSeededElectron(ctx);
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      },
    };
  } catch (error) {
    completeHeldResponses();
    if (ctx) await teardownSeededElectron(ctx);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    throw error;
  }
}
