/**
 * The plugin the Playwright suite seeds by default.
 *
 * It replaces the copies of sibling plugin repositories (local-indexer and
 * meeting) the suite used to read from the workspace: those repositories are
 * archived, and the app's verification must not depend on anything outside
 * this repository. One protocol-2 plugin carries the two surfaces the specs
 * need — a sidebar UI view (reached from the command menu) and a model- and
 * app-visible tool whose result proves the host dispatched into the plugin.
 *
 * The view calls that tool through its bridge when it mounts and shows the
 * answer, so opening the panel is also a plugin's first tool call: the
 * screenshot harness captures the host's permission dock from it.
 */
import type { FixturePlugin } from "./seed.js";

export const VIEW_FIXTURE_ID = "viewfixture";
export const VIEW_FIXTURE_VIEW_KEY = `plugin:${VIEW_FIXTURE_ID}:viewfixture_control`;
export const VIEW_FIXTURE_TOOL = "viewfixture_ping";
/** Only the plugin's handler can put this in a transcript; a prompt that names the tool cannot. */
export const VIEW_FIXTURE_DISPATCH_MARKER = `e2e-stub:${VIEW_FIXTURE_ID}:${VIEW_FIXTURE_TOOL}`;

const VIEW_FIXTURE_MANIFEST = {
  id: VIEW_FIXTURE_ID,
  name: "View Fixture",
  version: "1.0.0",
  description: "In-repository plugin with one sidebar view and one tool, for the Playwright suite.",
  entry: "dist/hostPlugin.js",
  requires: { minAppVersion: "0.12.0", hostProtocol: "2" },
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

/** Every file the plugin ships, relative to its directory, besides plugin.json. */
const VIEW_FIXTURE_FILES: Readonly<Record<string, string>> = {
  "dist/hostPlugin.js": `export default function createPlugin() {
  return {
    handlers: {
      ${VIEW_FIXTURE_TOOL}: async (args) => ({ ok: true, stub: ${JSON.stringify(VIEW_FIXTURE_DISPATCH_MARKER)}, args }),
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
