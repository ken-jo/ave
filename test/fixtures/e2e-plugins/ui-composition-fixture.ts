import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixturePlugin, writeFixtureRegistry, type FixturePlugin } from "./seed.js";

export const UI_COMPOSITION_TOOL = "ui_composition_show";
export const UI_COMPOSITION_NOTICE_TOOL = "ui_composition_notice";
const RESOURCE = "ui://compositionfixture/controls";
const HTML = `<!doctype html><html><body style="margin:0;padding:20px;background:#1464b4;color:white;font:20px sans-serif">
<h2>Composition app</h2><p id="status">Connecting</p><button id="pip">Float card</button><button id="fullscreen">Fill window</button>
<script type="module">
let id=0;const pending=new Map();window.fixtureContexts=[];
function request(method,params){const key=++id;parent.postMessage({jsonrpc:'2.0',id:key,method,params},'*');return new Promise((resolve,reject)=>pending.set(key,{resolve,reject}))}
addEventListener('message',event=>{if(event.source!==parent)return;const frame=event.data;if(frame.method==='ui/notifications/host-context-changed')fixtureContexts.push(frame.params);if(frame.id&&pending.has(frame.id)){const waiter=pending.get(frame.id);pending.delete(frame.id);frame.error?waiter.reject(frame.error):waiter.resolve(frame.result)}});
const initialized=await request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'compositionfixture',version:'1.0.0'},appCapabilities:{}});
fixtureContexts.push(initialized.hostContext);parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
window.requestMode=mode=>request('ui/request-display-mode',{mode});
document.getElementById('pip').onclick=()=>requestMode('pip');document.getElementById('fullscreen').onclick=()=>requestMode('fullscreen');
document.getElementById('status').textContent='Composition app ready';
</script></body></html>`;

const PLUGIN: FixturePlugin = {
  manifest: {
    id: "compositionfixture", name: "Composition fixture", version: "1.0.0",
    description: "Interactive card for native composition verification.", entry: "dist/host-plugin.js",
    requires: { minAppVersion: "0.12.0", hostProtocol: "5" },
    tools: [{ name: UI_COMPOSITION_TOOL, description: "Open the composition control card.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["model", "app"] } } },
      { name: UI_COMPOSITION_NOTICE_TOOL, description: "Raise a visible composition notice.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false } }],
    uiResources: [{ uri: RESOURCE }],
    alerts: { reasoning: "Expose a visible notice for composition verification.", kinds: [{
      id: "composition-notice", label: { en: "Composition notice" }, defaultEnabled: true,
      visibility: "user-visible", summary: { en: "The composition notice is ready." },
      prompt: { en: "Review the composition notice." }, actionLabel: { en: "Review notice" },
    }] },
  },
  files: {
    "dist/host-plugin.js": `export default function createPlugin({hostApi}){return {handlers:{${UI_COMPOSITION_TOOL}:async()=>({ok:true,_meta:{ui:{resourceUri:${JSON.stringify(RESOURCE)},title:"Composition app",height:240}}}),${UI_COMPOSITION_NOTICE_TOOL}:async()=>hostApi.raiseAlert({kind:"composition-notice",key:"composition-native-notice",priority:"normal"})},readUiResource:async()=>${JSON.stringify(HTML)},start(){},stop(){}}}`,
  },
};

export async function seedUiCompositionApp(aveHome: string): Promise<void> {
  const path = join(aveHome, "plugins", "registry.json");
  const registry = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, plugins: [] };
  assert.equal(registry.version, 1);
  assert(Array.isArray(registry.plugins));
  const entry = await writeFixturePlugin(aveHome, PLUGIN);
  writeFixtureRegistry(aveHome, [...registry.plugins.filter((prior: { id: string }) => prior.id !== entry.id), entry]);
}
