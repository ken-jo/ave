/** knownToolOwners must contain only model-visible names; app-only auth and card tools never gain pre-runtime ownership. */
import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestPluginRuntime as PluginRuntime } from "../../__tests__/test-helpers.js";
import type { PluginManifest } from "../../types.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGIN_ID = "auth-plugin";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Auth Plugin",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "x",
  tools: [
    { name: "ap_list", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
    { name: "ap_toggle", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
    { name: "ap_status", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "ap_login", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
    { name: "ap_ui_rows", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
  ],
  auth: { statusTool: "ap_status", loginTool: "ap_login" },
};

const MODEL_VISIBLE = ["ap_list", "ap_toggle"];
const APP_ONLY = ["ap_status", "ap_login", "ap_ui_rows"];
const AUTH_TRIO = ["ap_status", "ap_login"];

function runtimeWithOwners(): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  // Use the real ownership setter while methodMap stays empty to isolate the pre-runtime snapshot.
  (rt as unknown as {
    rememberPluginManifest(id: string, m: typeof MANIFEST, a: undefined): void;
  }).rememberPluginManifest(PLUGIN_ID, MANIFEST, undefined);
  return rt;
}

describe("knownToolOwners — MODEL-ONLY access-control non-widening (#885 §2.4a)", () => {
  it("the pre-runtime snapshot resolves ONLY the model-visible names (every app-only name excluded)", () => {
    const rt = runtimeWithOwners();
    for (const name of MODEL_VISIBLE) {
      expect(rt.resolveToolOwner(name)).toBe(PLUGIN_ID);
    }
    // Governed registration does not make app-only names model-owned.
    for (const name of APP_ONLY) {
      expect(rt.resolveToolOwner(name)).toBeUndefined();
    }
    const owned = [...MODEL_VISIBLE, ...APP_ONLY].filter(
      (n) => rt.resolveToolOwner(n) === PLUGIN_ID,
    );
    expect(owned.sort()).toEqual([...MODEL_VISIBLE].sort());
  });

  it("PINS THE MAP'S CONTENTS: knownToolOwners holds the model-visible names and nothing else", () => {
    // Pin map membership as well as observable resolution so an app-visible filter cannot widen ownership.
    const rt = runtimeWithOwners();
    const map = (rt as unknown as { knownToolOwners: Map<string, string> }).knownToolOwners;

    expect([...map.keys()].sort()).toEqual([...MODEL_VISIBLE].sort());
    expect([...map.values()]).toEqual(MODEL_VISIBLE.map(() => PLUGIN_ID));
    for (const name of APP_ONLY) expect(map.has(name)).toBe(false);
  });

  it("the 'plugin still installing' guard fires for a model-visible owner but early-returns for the app-only auth trio", () => {
    const rt = runtimeWithOwners();
    const internals = rt as unknown as {
      preparation: { preparingPluginIds: Set<string> };
      throwIfToolOwnerNotReady(toolName: string): void;
    };
    internals.preparation.preparingPluginIds.add(PLUGIN_ID);
    expect(() => internals.throwIfToolOwnerNotReady("ap_list")).toThrow(/still installing/);
    // Auth names must bypass the pre-runtime owner guard because they have no model owner.
    for (const name of AUTH_TRIO) {
      expect(() => internals.throwIfToolOwnerNotReady(name)).not.toThrow();
    }
  });
});
