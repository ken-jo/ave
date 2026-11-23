import { HEADLESS_CHILD_ENTRY_POINTS } from "./headless-bundle-boundary.mjs";

/** Every entry of the host's esbuild graph but the verification probe, as paths from the repository root. Each imports
 * src/main/windows-program-lookup.ts before any other module. */
export const MAIN_ENTRY_POINTS = Object.freeze({
  main: "src/main.ts",
  headless: "src/headless.ts",
  ...HEADLESS_CHILD_ENTRY_POINTS,
  "subscription-grok-tool-policy-hook": "src/main/subscription-grok-tool-policy-hook.ts",
  "subscription-tool-mcp-server": "src/main/subscription-tool-mcp-server.ts",
  "mxc-extension-supervisor": "src/permissions/mxc-extension-supervisor.ts",
  // A confined plugin child process runs this file directly, so it is its own entry and no module inside main.js.
  "plugin-child-main": "src/plugins/isolation/plugin-child-main.ts",
  "memory-map-worker": "src/main/memory-map/worker-main.ts",
  "memory-map-child": "src/main/memory-map/inference-child-main.ts",
  "preview-document-child-main": "src/tools/preview-document-child-main.ts",
});
