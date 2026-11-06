// Repository-owned fixtures keep local UI verification independent of sibling plugin installations.
import type { FixturePlugin } from "./seed.js";

export const VIEW_FIXTURE_ID = "viewfixture";
export const VIEW_FIXTURE_VIEW_KEY = `plugin:${VIEW_FIXTURE_ID}:viewfixture_control`;
export const VIEW_FIXTURE_TOOL = "viewfixture_ping";
// Only actual plugin dispatch can emit this marker; naming the tool in a prompt cannot.
export const VIEW_FIXTURE_DISPATCH_MARKER = `e2e-fixture:${VIEW_FIXTURE_ID}:${VIEW_FIXTURE_TOOL}`;

const VIEW_FIXTURE_MANIFEST = {
  id: VIEW_FIXTURE_ID,
  name: "View Fixture",
  version: "1.0.0",
  description: "In-repository plugin with one sidebar view and one tool, for local UI verification.",
  entry: "dist/hostPlugin.js",
  requires: { minAppVersion: "0.12.0", hostProtocol: "5" },
  tools: [{
    name: VIEW_FIXTURE_TOOL,
    description: "Return a marker that proves the host dispatched this call into the plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ["model", "app"] } },
  }],
  uiResources: [{ uri: "ui://viewfixture/control" }],
  ui: [{
    id: "viewfixture_control",
    slot: "sidebar",
    kind: "mcp-app",
    displayName: "View Fixture",
    title: "View Fixture",
    description: "Sidebar view used to prove plugin views reach the command menu.",
    resourceUri: "ui://viewfixture/control",
  }],
};

const VIEW_FIXTURE_HTML = `<!doctype html><html><body>
<h2>View Fixture</h2><p id="status">Connecting…</p><button id="draft">Stage draft</button>
<script type="module">
let nextId = 0;
const pending = new Map();
function request(method, params) {
  const id = ++nextId;
  parent.postMessage({jsonrpc:'2.0', id, method, params}, '*');
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}
addEventListener('message', async (event) => {
  if (event.source !== parent) return;
  const frame = event.data;
  if (frame.id && pending.has(frame.id)) {
    const waiter = pending.get(frame.id); pending.delete(frame.id);
    frame.error ? waiter.reject(frame.error) : waiter.resolve(frame.result);
  }
});
const result = await request('ui/initialize', {protocolVersion:'2026-01-26', appInfo:{name:'viewfixture', version:'1.0.0'}, appCapabilities:{}});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}}, '*');
document.getElementById('status').textContent = 'Standard app ready';
document.getElementById('draft').onclick = async () => {
  await request('ui/message', {role:'user', content:[{type:'text',text:'Review the selected fixture item'}]});
  document.getElementById('status').textContent = 'Draft staged';
};
</script></body></html>`;

const VIEW_FIXTURE_FILES: Readonly<Record<string, string>> = {
  "dist/hostPlugin.js": `export default function createPlugin() {
  return {
    handlers: {
      ${VIEW_FIXTURE_TOOL}: async (args) => ({ ok: true, marker: ${JSON.stringify(VIEW_FIXTURE_DISPATCH_MARKER)}, args }),
    },
    readUiResource: async () => ${JSON.stringify(VIEW_FIXTURE_HTML)},
    start() {},
    stop() {}
  };
}
`,
};

export const VIEW_FIXTURE: FixturePlugin = {
  manifest: VIEW_FIXTURE_MANIFEST,
  files: VIEW_FIXTURE_FILES,
};
