import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { AveApi } from "../../../src/ui/renderer/types.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { writeFixturePlugin, writeFixtureRegistry, type FixtureRegistryEntry } from "../../fixtures/e2e-plugins/seed.js";
import { launchUiLayerFixture } from "./browser-ui-layer-fixture.js";
import { nativePageHole } from "./browser-ui-overlay-fixtures.js";
import { setWindowSize } from "./seeded-electron.js";

const DECISION_PLUGIN_ID = "decisionfixture";
const DECISION_TOOL = "decisionfixture_record";
const DECISION_OPEN_TOOL = "decisionfixture_open";
const DECISION_RESOURCE = "ui://decisionfixture/controls";
const QUESTION = "Which measured flow should continue?";
const DECISION_HTML = `<!doctype html><html><body style="margin:0;padding:16px;font:16px sans-serif">
<p id="status">Connecting</p><button id="record" type="button">Record decision</button>
<script type="module">
let id=0;const pending=new Map();window.decisionState={ready:false,trusted:false,activation:false,result:null,error:null};
function request(method,params){const key=++id;parent.postMessage({jsonrpc:'2.0',id:key,method,params},'*');return new Promise((resolve,reject)=>pending.set(key,{resolve,reject}))}
addEventListener('message',event=>{if(event.source!==parent)return;const frame=event.data;if(frame.id&&pending.has(frame.id)){const waiter=pending.get(frame.id);pending.delete(frame.id);frame.error?waiter.reject(frame.error):waiter.resolve(frame.result)}});
await request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'decisionfixture',version:'1.0.0'},appCapabilities:{}});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
document.getElementById('record').onclick=async event=>{
  decisionState.trusted=event.isTrusted;decisionState.activation=navigator.userActivation.isActive;
  try{decisionState.result=await request('tools/call',{name:${JSON.stringify(DECISION_TOOL)},arguments:{}})}catch(error){decisionState.error=String(error)}
};
decisionState.ready=true;document.getElementById('status').textContent='Decision app ready';
</script></body></html>`;

async function installDecisionPlugin(aveHome: string): Promise<string> {
  const marker = join(aveHome, "decision-fixture-record.json");
  const entry = await writeFixturePlugin(aveHome, {
    manifest: {
      id: DECISION_PLUGIN_ID, name: "Decision Fixture", version: "1.0.0",
      description: "Record one isolated fixture decision through governed tool execution.", entry: "dist/hostPlugin.js",
      requires: { minAppVersion: "0.12.0", hostProtocol: "5" },
      tools: [{ name: DECISION_OPEN_TOOL, description: "Open the decision control card.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["model", "app"] } } },
      { name: DECISION_TOOL, description: "Write the isolated decision record.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false }, _meta: { ui: { visibility: ["model", "app"] } } }],
      uiResources: [{ uri: DECISION_RESOURCE }],
    },
    files: { "dist/hostPlugin.js": `import { writeFile } from "node:fs/promises";
export default function createPlugin() {
  return { handlers: {
  ${DECISION_OPEN_TOOL}: async () => ({ ok: true, _meta: { ui: { resourceUri: ${JSON.stringify(DECISION_RESOURCE)}, title: "Decision app", height: 144 } } }),
  ${DECISION_TOOL}: async () => {
    await writeFile(${JSON.stringify(marker)}, JSON.stringify({ recorded: true }), { mode: 0o600 });
    return { recorded: true };
  } }, readUiResource: async () => ${JSON.stringify(DECISION_HTML)}, start() {}, stop() {} };
}
` },
  });
  let entries: FixtureRegistryEntry[] = [];
  try {
    const registry = JSON.parse(await fs.readFile(join(aveHome, "plugins", "registry.json"), "utf8")) as { plugins?: FixtureRegistryEntry[] };
    assert(Array.isArray(registry.plugins), "Fixture registry entries unavailable");
    entries = registry.plugins;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  writeFixtureRegistry(aveHome, [...entries.filter(candidate => candidate.id !== entry.id), entry]);
  return marker;
}

export async function launchDecisionFixture(width: number, options: { withDecisionPlugin?: boolean } = {}) {
  let marker: string | undefined;
  const fixture = await launchUiLayerFixture(width, options.withDecisionPlugin
    ? { prepareHome: async aveHome => { marker = await installDecisionPlugin(aveHome); }, admitPreparedPlugins: true } : {});
  try {
    await fixture.clickFromAgent();
    await expect.poll(fixture.toolReady).toBe(true);
    return {
      ...fixture,
      secondUrl: fixture.url.replace("127.0.0.1", "localhost"),
      requestNavigation: async () => {
        await expect.poll(fixture.toolReady).toBe(true);
        const control = await fixture.control();
        fixture.requestTool("browser_navigate", { tabId: control.tabId, url: fixture.url.replace("127.0.0.1", "localhost") });
        const dock = fixture.page.getByTestId(TEST_IDS.approvalDock);
        await expect(dock.getByTestId("browser-site-approval-card")).toBeVisible();
        return dock;
      },
      requestQuestion: async () => {
        await expect.poll(fixture.toolReady).toBe(true);
        fixture.requestTool("ask_user_question", { questions: [{ question: QUESTION, choices: ["Continue", "Stop"], recommendedIndex: 0 }] });
        const question = fixture.page.getByTestId("ask-user-question-card");
        await expect(question).toContainText(QUESTION);
        return question;
      },
      startPaneApproval: async () => {
        const recordPath = marker;
        assert(recordPath, "Pane approval fixture must be installed before launch");
        await fixture.page.getByTestId("pane-action-surface.chat").click();
        const work = fixture.page.getByTestId("pane-work-panel");
        const side = work.getByTestId("side-chat-view");
        await expect(side).toBeVisible();
        const receipt = fixture.queueNextTurnTool("request_plugin", { pluginId: DECISION_PLUGIN_ID });
        const composer = side.getByTestId(TEST_IDS.composerTextarea);
        await composer.fill("Open the decision plugin and prepare the isolated record.");
        await composer.press("Enter");
        await expect.poll(fixture.nextTurnDispatched).toBe(receipt);
        await expect.poll(fixture.toolReady).toBe(true);
        expect(fixture.toolResults().at(-1)).toContain(DECISION_PLUGIN_ID);
        const mode = await fixture.page.evaluate(() => window.ave.permission.setMode("strict"));
        expect(mode.ok).toBe(true);
        fixture.requestTool(DECISION_TOOL, {});
        const dock = side.getByTestId(TEST_IDS.approvalDock);
        await expect(dock).toHaveAttribute("data-approval-tool-name", DECISION_TOOL);
        await expect(dock).toBeVisible();
        await expect(fs.readFile(recordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        return { work, side, dock, readRecord: async () => JSON.parse(await fs.readFile(recordPath, "utf8")) as { recorded: boolean } };
      },
      startLaneApproval: async () => {
        const recordPath = marker;
        assert(recordPath, "Lane approval fixture must be installed before launch");
        await expect.poll(() => fixture.page.evaluate(async id => {
          const api: AveApi = window.aveApi;
          return (await api.listPluginCards()).find(card => card.id === id)?.loadStatus;
        }, DECISION_PLUGIN_ID)).toBe("loaded");
        fixture.requestTool("request_plugin", { pluginId: DECISION_PLUGIN_ID });
        await expect.poll(fixture.toolReady).toBe(true);
        expect(fixture.toolResults().at(-1)).toContain(DECISION_PLUGIN_ID);
        fixture.requestTool(DECISION_OPEN_TOOL, {});
        await expect.poll(fixture.toolReady).toBe(true);
        const appView = fixture.page.locator('webview[src^="ave-mcp-app:"]');
        await expect(appView).toHaveCount(1);
        await appView.scrollIntoViewIfNeeded();
        const readApp = () => fixture.app.evaluate(async ({ webContents }) => {
          const guests = webContents.getAllWebContents().filter(contents => contents.getURL().startsWith("ave-mcp-app://"));
          if (guests.length !== 1) throw new Error("Decision app guest unavailable");
          const [guest] = guests;
          if (!guest) throw new Error("Decision app guest unavailable");
          return guest.executeJavaScript(`(() => {
            const frame=document.querySelector('iframe');const state=frame?.contentWindow?.decisionState;
            const button=frame?.contentDocument?.getElementById('record');if(!state||!button)return null;
            const outer=frame.getBoundingClientRect(),inner=button.getBoundingClientRect();
            return {...state,button:{x:outer.x+inner.x+inner.width/2,y:outer.y+inner.y+inner.height/2}};
          })()`) as Promise<{ ready: boolean; trusted: boolean; activation: boolean;
            result: { isError?: boolean; content: Array<{ type: string; text?: string }> } | null; error: string | null;
            button: { x: number; y: number } } | null>;
        });
        await expect.poll(async () => (await readApp())?.ready).toBe(true);
        const mode = await fixture.page.evaluate(() => window.ave.permission.setMode("strict"));
        expect(mode.ok).toBe(true);
        const appBox = await appView.boundingBox();
        const state = await readApp();
        assert(appBox && state, "Decision app button geometry unavailable");
        // Press the live app button; the standard bridge owns tool identity and consent.
        await fixture.page.mouse.click(appBox.x + state.button.x, appBox.y + state.button.y);
        await expect.poll(async () => {
          const state = await readApp();
          return { trusted: state?.trusted, activation: state?.activation };
        }).toEqual({ trusted: true, activation: true });
        const lane = fixture.page.getByTestId("approval-lane-card");
        await expect(lane).toHaveAttribute("data-approval-tool-name", DECISION_TOOL);
        await expect(lane).toBeVisible();
        await expect(fs.readFile(recordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        return { lane, readResult: async () => {
          await expect.poll(async () => (await readApp())?.result ?? null).not.toBeNull();
          const state = await readApp();
          assert(state?.result, "Decision app result unavailable");
          expect(state.error).toBeNull();
          expect(state.result.isError).not.toBe(true);
          const text = state.result.content.find(block => block.type === "text")?.text;
          assert(text, "Decision app result text unavailable");
          return JSON.parse(text) as { recorded: boolean };
        }, readRecord: async () => JSON.parse(await fs.readFile(recordPath, "utf8")) as { recorded: boolean } };
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export async function moveDecisionPageToMain(fixture: Awaited<ReturnType<typeof launchDecisionFixture>>, width: number,
  options: { allowSibling?: boolean } = {}) {
  // A same-pane request replaces the originating conversation before restoring the final width.
  await setWindowSize(fixture.app, options.allowSibling ? width : 900, 800);
  await fixture.page.getByTestId("chat-side-panel-move-to-main").click();
  await expect(fixture.page.getByTestId("web-panel")).toBeVisible();
  await setWindowSize(fixture.app, width, 800);
  await expect(nativePageHole(fixture)).toBeVisible();
}
