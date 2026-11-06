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
  auth: { statusTool: "viewfixture_status", loginTool: "viewfixture_login" },
  tools: [{
    name: VIEW_FIXTURE_TOOL,
    description: "Return a marker that proves the host dispatched this call into the plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ["model", "app"] } },
  }, ...["viewfixture_status", "viewfixture_login", "viewfixture_set_auth", "viewfixture_open_dock"].map((name) => ({
    name, description: "Fixture authentication and dock controls", inputSchema: { type: "object", properties: { authenticated: { type: "boolean" } }, additionalProperties: false },
    _meta: { ui: { visibility: ["app"] } },
  }))],
  uiResources: [{ uri: "ui://viewfixture/control" }],
  ui: [{
    id: "viewfixture_control",
    slot: "sidebar",
    kind: "mcp-app",
    displayName: "View Fixture",
    title: "View Fixture",
    description: "Sidebar view used to prove plugin views reach the command menu.",
    resourceUri: "ui://viewfixture/control",
  }, {
    id: "viewfixture_dock", slot: "floating", kind: "mcp-app", title: "View Fixture Dock", resourceUri: "ui://viewfixture/control",
  }],
};

const VIEW_FIXTURE_HTML = `<!doctype html><html><body>
<h2>View Fixture</h2><p id="status">Connecting…</p><button id="draft">Stage draft</button>
<script type="module">
let nextId = 0;
const pending = new Map();
window.fixtureHostContexts = [];
function applyHostContext(context) {
  window.fixtureHostContexts.push(context);
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) document.documentElement.style.setProperty(name, value);
}
function request(method, params) {
  const id = ++nextId;
  parent.postMessage({jsonrpc:'2.0', id, method, params}, '*');
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}
addEventListener('message', async (event) => {
  if (event.source !== parent) return;
  const frame = event.data;
  if (frame.method === 'ui/notifications/host-context-changed') applyHostContext(frame.params);
  if (frame.id && pending.has(frame.id)) {
    const waiter = pending.get(frame.id); pending.delete(frame.id);
    frame.error ? waiter.reject(frame.error) : waiter.resolve(frame.result);
  }
});
const result = await request('ui/initialize', {protocolVersion:'2026-01-26', appInfo:{name:'viewfixture', version:'1.0.0'}, appCapabilities:{}});
applyHostContext(result.hostContext);
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}}, '*');
document.getElementById('status').textContent = 'Standard app ready';
document.getElementById('draft').onclick = async () => {
  await request('ui/message', {role:'user', content:[{type:'text',text:'Review the selected fixture item'}]});
  document.getElementById('status').textContent = 'Draft staged';
};
</script></body></html>`;

const VIEW_FIXTURE_FILES: Readonly<Record<string, string>> = {
  "dist/hostPlugin.js": `export default function createPlugin({ hostApi }) {
  let authenticated = true;
  return {
    handlers: {
      viewfixture_status: async () => ({ authenticated, account: "fixture-account" }),
      viewfixture_login: async () => ({ authenticated: (authenticated = true) }),
      viewfixture_set_auth: async ({ authenticated: next }) => ({ authenticated: (authenticated = next) }),
      viewfixture_open_dock: async () => { await hostApi.attachFloatingPanel({ extensionId: "viewfixture_dock", height: 240 }); return { ok: true }; },
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
