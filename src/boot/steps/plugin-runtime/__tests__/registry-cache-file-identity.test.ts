import { statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import { readPluginRegistry } from "../../../../plugins/registry.js";
import { createRegistryEntryCache } from "../registry-cache.js";

vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));
vi.mock("../../../../plugins/registry.js", () => ({ readPluginRegistry: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe("registry cache exact identity", () => {
  it.each(["ino", "dev"] as const)("revokes a stale grant after an exact %s replacement", async (field) => {
    const original = Object.assign(statSync(new URL(import.meta.url), { bigint: true }), {
      dev: 7n, ino: 2n ** 60n, size: 100n, mtimeNs: 10n, [field]: 2n ** 60n,
    });
    const replaced = { ...original, [field]: original[field] + 1n };
    expect(Number(original[field])).toBe(Number(replaced[field]));
    vi.mocked(stat).mockResolvedValueOnce(original).mockResolvedValue(replaced);
    vi.mocked(readPluginRegistry).mockResolvedValueOnce({
      version: 1,
      plugins: [{ id: "entry", manifestPath: "entry/plugin.json", installSource: "admin" }],
    }).mockResolvedValue({ version: 1, plugins: [] });
    const cache = createRegistryEntryCache({ registryPath: "/registry.json", log: { warn: vi.fn() } });
    await cache.refreshRegistryEntryCache();
    expect(cache.getRegistryEntry("entry")?.installSource).toBe("admin");
    await cache.refreshRegistryEntryCacheIfChanged();
    expect(cache.getRegistryEntry("entry")).toBeUndefined();
    expect(stat).toHaveBeenCalledWith("/registry.json", { bigint: true });
    expect(readPluginRegistry).toHaveBeenCalledTimes(2);
  });
});
