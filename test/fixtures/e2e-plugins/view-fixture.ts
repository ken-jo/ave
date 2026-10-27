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
  requires: { minAppVersion: "0.12.0", hostProtocol: "4" },
  tools: [{
    name: VIEW_FIXTURE_TOOL,
    description: "Return a marker that proves the host dispatched this call into the plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ["model", "app"] } },
  }],
  ui: [{
    id: "viewfixture_control",
    slot: "sidebar",
    kind: "embedded-module",
    displayName: "View Fixture",
    title: "View Fixture",
    description: "Sidebar view used to prove plugin views reach the command menu.",
    entry: "dist/ui/view.js",
    exportName: "default",
  }],
};

const VIEW_FIXTURE_FILES: Readonly<Record<string, string>> = {
  "dist/hostPlugin.js": `export default function createPlugin() {
  return {
    handlers: {
      ${VIEW_FIXTURE_TOOL}: async (args) => ({ ok: true, marker: ${JSON.stringify(VIEW_FIXTURE_DISPATCH_MARKER)}, args }),
    },
    start() {},
    stop() {}
  };
}
`,
  "dist/ui/view.js": `export async function mount({ root, bridge }) {
  root.textContent = "";
  const heading = document.createElement("h2");
  heading.textContent = "View Fixture";
  const status = document.createElement("p");
  status.textContent = "Calling ${VIEW_FIXTURE_TOOL}…";
  root.append(heading, status);
  try {
    const answer = await bridge.callTool(${JSON.stringify(VIEW_FIXTURE_TOOL)}, {});
    status.textContent = "Host dispatched: " + JSON.stringify(answer);
  } catch (error) {
    status.textContent = "Tool call refused: " + (error && error.message ? error.message : String(error));
  }
}
export default { mount };
`,
};

export const VIEW_FIXTURE: FixturePlugin = {
  manifest: VIEW_FIXTURE_MANIFEST,
  files: VIEW_FIXTURE_FILES,
};
