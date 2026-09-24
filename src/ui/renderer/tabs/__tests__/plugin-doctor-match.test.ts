/**
 * Plugin Doctor's repair: the entry it reinstalls, and what it asks the git
 * marketplace for. The repair skips the update review only because it puts the
 * version on disk back from the plugin's own source; these assertions red when
 * it would pick another source, another kind, or the newer candidate.
 */
import { describe, it, expect, vi } from "vitest";
import {
  findPluginDoctorEntry,
  getPluginDoctorInstallKey,
  repairPluginFromMarketplace,
} from "../plugin-doctor-match.js";
import type { CatalogEntryView, PackageStateView } from "../../../../shared/git-marketplace.js";
import { pluginCardSummary as card } from "./test-helpers.js";

function entry(name: string, state: PackageStateView, over: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return {
    key: { sourceId: "ave", kind: "plugin", name },
    sourceOrigin: "official",
    sourceLabel: "Ave",
    displayName: name,
    description: "",
    keywords: [],
    state,
    required: false,
    runsCode: true,
    ...over,
  };
}

function market(entries: CatalogEntryView[]) {
  return {
    listCatalog: vi.fn(async () => ({ ok: true as const, value: { entries, counts: {} as never, sourceCount: 1, syncedAt: null } })),
    planInstall: vi.fn(async () => ({ ok: true as const, value: { planId: "p1" } as never })),
    executeInstall: vi.fn(async () => ({
      ok: true as const,
      value: { key: { sourceId: "ave", kind: "plugin" as const, name: "weather" }, version: "1.0.0", action: { action: "replace" as const, direction: "reinstall" as const, from: "1.0.0" }, rungs: [], connectionWarning: null },
    })),
  };
}

describe("getPluginDoctorInstallKey", () => {
  it("prefers the first install alias over the plugin id", () => {
    expect(getPluginDoctorInstallKey(card({ id: "weather", installAliases: ["@ave/weather"] })))
      .toBe("@ave/weather");
  });

  it("falls back to the plugin id when there is no alias", () => {
    expect(getPluginDoctorInstallKey(card({ id: "weather" }))).toBe("weather");
  });
});

describe("findPluginDoctorEntry", () => {
  it("finds the plugin's own installed entry by name", () => {
    const entries = [entry("other", { state: "installed", version: "1.0.0" }), entry("weather", { state: "installed", version: "1.0.0" })];
    expect(findPluginDoctorEntry(card({ id: "weather" }), entries)?.key).toEqual({ sourceId: "ave", kind: "plugin", name: "weather" });
  });

  it("skips another kind of the same name", () => {
    const skill = entry("weather", { state: "installed", version: "1.0.0" }, { key: { sourceId: "ave", kind: "skill", name: "weather" } });
    expect(findPluginDoctorEntry(card({ id: "weather" }), [skill])).toBeNull();
  });

  it("returns null for a plugin bound to no source", () => {
    const unbound = entry("weather", { state: "unbound", version: "1.0.0" }, { key: { sourceId: null, kind: "plugin", name: "weather" } });
    expect(findPluginDoctorEntry(card({ id: "weather" }), [unbound])).toBeNull();
  });
});

describe("repairPluginFromMarketplace", () => {
  it("reinstalls the version on disk, not the newer candidate", async () => {
    const api = market([entry("weather", { state: "update", from: "1.0.0", to: "2.0.0" })]);
    const repair = await repairPluginFromMarketplace(api, card({ id: "weather" }));
    expect(repair.status).toBe("reinstalled");
    expect(api.listCatalog).toHaveBeenCalledWith({ kind: "plugin", installedOnly: true });
    expect(api.planInstall).toHaveBeenCalledWith({ sourceId: "ave", kind: "plugin", name: "weather", version: "1.0.0" });
    expect(api.executeInstall).toHaveBeenCalledWith("p1");
  });

  it("installs the candidate when the version on disk cannot be read", async () => {
    const api = market([entry("weather", { state: "installed", version: null })]);
    await repairPluginFromMarketplace(api, card({ id: "weather" }));
    expect(api.planInstall).toHaveBeenCalledWith({ sourceId: "ave", kind: "plugin", name: "weather" });
  });

  it("reports an unbound plugin without planning anything", async () => {
    const api = market([]);
    await expect(repairPluginFromMarketplace(api, card({ id: "weather" }))).resolves.toEqual({ status: "unbound" });
    expect(api.planInstall).not.toHaveBeenCalled();
  });

  it("carries a failed plan's message", async () => {
    const api = market([entry("weather", { state: "installed", version: "1.0.0" })]);
    api.planInstall.mockResolvedValueOnce({ ok: false, code: "PACKAGE_INCOMPATIBLE", message: "ave does not list weather 1.0.0" } as never);
    await expect(repairPluginFromMarketplace(api, card({ id: "weather" }))).resolves.toEqual({
      status: "failed",
      message: "ave does not list weather 1.0.0",
    });
    expect(api.executeInstall).not.toHaveBeenCalled();
  });
});
