import { describe, expect, it, vi } from "vitest";
import { createPluginRetirementPort } from "../retired-config.js";
import { effectivePluginConfig } from "../effective-config.js";
import type { RetiredPluginConfigRecord } from "../../shared/alerts-types.js";
import type { PluginManifest } from "../types.js";

const manifest = {
  id: "retired-fixture", version: "1.0.0", entry: "index.js", tools: [], description: "Retirement fixture", config: { manifestOnly: true, winner: "manifest" },
  configSchema: { properties: {
    schemaOnly: { type: "boolean", default: true }, winner: { type: "string", default: "schema" },
    token: { type: "string", format: "secret", default: "never-retain" },
  } },
} as PluginManifest;
const retain = { reason: "revoked" as const, sourceId: "fixture", successors: { plugins: [{ pluginId: "successor-fixture" }], hostKinds: [] } };

function setup(enabled = true) {
  let records: Record<string, RetiredPluginConfigRecord> = {};
  const get = vi.fn(() => structuredClone(records));
  const set = vi.fn(async (_key: string, value: typeof records) => { records = structuredClone(value); });
  const readManifest = vi.fn(async () => ({ manifest, enabled, sourceId: "fixture" }));
  const port = createPluginRetirementPort({
    settings: { get, set, getPluginConfig: () => ({ winner: "saved" }) } as never,
    marketplace: { getInstalledConfigManifest: readManifest }, wildcard: () => ({ wildcardOnly: true, winner: "wildcard" }),
    appVersion: () => "0.12.0",
  });
  return { port, get, set, readManifest };
}

describe("retired plugin config capture", () => {
  it("uses the live getter layers, preserves disabled state, and excludes secrets", async () => {
    const { port } = setup(false);
    const record = await port.capture("retired-fixture", retain);
    expect(record).toEqual({ config: { schemaOnly: true, manifestOnly: true, wildcardOnly: true, winner: "saved" },
      enabled: false, sourceId: "fixture", successors: retain.successors, retiredAtAppVersion: "0.12.0", consumedBy: [] });
    expect(effectivePluginConfig(manifest, { winner: "wildcard" }, {}).winner).toBe("wildcard");
    expect(effectivePluginConfig(manifest, {}, {}).winner).toBe("manifest");
  });
  it("never rewrites an existing consumed record, even without a readable install", async () => {
    const { port, set, readManifest } = setup();
    const record = await port.capture("retired-fixture", retain);
    record.consumedBy = ["successor-fixture"];
    await port.writeIfAbsent("retired-fixture", record);
    set.mockClear();
    readManifest.mockRejectedValue(new Error("manifest gone"));
    expect(await port.capture("retired-fixture", retain)).toEqual(record);
    await port.writeIfAbsent("retired-fixture", { ...record, consumedBy: [], retiredAtAppVersion: "0.13.0" });
    expect(set).not.toHaveBeenCalled();
  });
  it("refuses capture after the installed source changes", async () => {
    const { port } = setup();
    await expect(port.capture("retired-fixture", { ...retain, sourceId: "other" })).rejects.toThrow("identity changed");
  });
});
