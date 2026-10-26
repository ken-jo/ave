import { describe, expect, it, vi } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { normalizeMarketplace } from "../../../data/settings-normalization.js";
import { legacySelectedThemes, migrateLegacyContent, type LegacyActivations, type LegacyContentKind } from "../legacy-content.js";

const OFFICIAL = new Set(["theme:aurora", "theme:nebula", "language:korean", "provider:openrouter", "provider:nous-research"]);

function harness(activations: LegacyActivations, options: { installed?: string[]; adopt?: (kind: LegacyContentKind, name: string) => Promise<void> } = {}) {
  const installed = new Set(options.installed ?? []);
  const adopt = vi.fn(options.adopt ?? (async (kind: LegacyContentKind, name: string) => void installed.add(`${kind}:${name}`)));
  const release = vi.fn(async () => undefined);
  const warn = vi.fn();
  const run = () =>
    migrateLegacyContent({
      activations,
      listed: (kind, name) => OFFICIAL.has(`${kind}:${name}`),
      installed: async (kind, name) => installed.has(`${kind}:${name}`),
      adopt,
      release,
      log: { warn },
    });
  return { run, adopt, release, warn };
}

describe("legacySelectedThemes", () => {
  it("names the selected theme when it is a package, with the violet counterpart the old followSystem alternated", () => {
    expect(legacySelectedThemes({ bundleId: "tokyo-night" })).toEqual(["tokyo-night"]);
    expect(legacySelectedThemes({ bundleId: "violet-light", followSystem: false })).toEqual(["violet-light"]);
    expect(legacySelectedThemes({ bundleId: "violet-light", followSystem: true })).toEqual(["violet-light", "violet-dark"]);
    expect(legacySelectedThemes({ bundleId: "tokyo-night", followSystem: true })).toEqual(["tokyo-night"]);
    expect(legacySelectedThemes({ bundleId: "moonstone" })).toEqual([]);
    expect(legacySelectedThemes({ bundleId: "Not_A_Theme" })).toEqual([]);
  });
});

describe("migrateLegacyContent", () => {
  it("preserves the legacy Korean activation through normalization and adopts its official overlay", async () => {
    const marketplace = normalizeMarketplace({ installedLanguagePacks: ["ko"] });
    expect(marketplace.installedLanguagePacks).toEqual(["ko"]);
    const { run, adopt, release } = harness({ themes: [], locales: marketplace.installedLanguagePacks, providers: [] });

    expect(await run()).toEqual({
      adopted: [{ source: "ave", kind: "language", name: "korean" }],
      failed: [],
    });
    expect(adopt).toHaveBeenCalledExactlyOnceWith("language", "korean");
    expect(release).toHaveBeenCalledWith({ themes: [], locales: ["ko"] });
  });

  it("adopts every legacy activation from the official source and drops the theme and language list entries", async () => {
    const { run, adopt, release } = harness({ themes: ["aurora"], locales: ["ko"], providers: ["nous-research", "openrouter", "openrouter"] });

    const report = await run();

    expect(adopt.mock.calls).toEqual([
      ["theme", "aurora"],
      ["language", "korean"],
      ["provider", "nous-research"],
      ["provider", "openrouter"],
    ]);
    expect(report).toEqual({
      adopted: [
        { source: "ave", kind: "theme", name: "aurora" },
        { source: "ave", kind: "language", name: "korean" },
        { source: "ave", kind: "provider", name: "nous-research" },
        { source: "ave", kind: "provider", name: "openrouter" },
      ],
      failed: [],
    });
    expect(release).toHaveBeenCalledWith({ themes: ["aurora"], locales: ["ko"] });
  });

  it("drops the list entry of a package already installed, without installing it again", async () => {
    const { run, adopt, release } = harness({ themes: ["aurora"], locales: [], providers: ["openrouter"] }, { installed: ["theme:aurora", "provider:openrouter"] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(adopt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ themes: ["aurora"], locales: [] });
  });

  it("leaves what the official source does not list in settings, and says so", async () => {
    const { run, adopt, release, warn } = harness({ themes: ["retired"], locales: ["fr"], providers: ["gone"] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(adopt).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("language fr"),
      expect.stringContaining("theme retired"),
      expect.stringContaining("provider gone"),
    ]);
  });

  it("leaves an activation another installed package provides to that package", async () => {
    const { run, release } = harness(
      { themes: [], locales: ["ko"], providers: [] },
      { adopt: async () => { throw new MarketplaceError("PACKAGE_ID_CONFLICT", "hangul already provides the ko language"); } },
    );
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(release).toHaveBeenCalledWith({ themes: [], locales: ["ko"] });
  });

  it("reports a failed install and keeps its list entry, and migrates the rest", async () => {
    const { run, release } = harness(
      { themes: ["aurora", "nebula"], locales: [], providers: [] },
      {
        adopt: async (_kind, name) => {
          if (name === "aurora") throw new MarketplaceError("PACKAGE_INCOMPATIBLE", "aurora 2.0.0 needs Ave 9.0.0");
        },
      },
    );
    const report = await run();
    expect(report.adopted).toEqual([{ source: "ave", kind: "theme", name: "nebula" }]);
    expect(report.failed).toEqual([{ key: { source: "ave", kind: "theme", name: "aurora" }, message: expect.stringContaining("needs Ave") }]);
    expect(release).toHaveBeenCalledWith({ themes: ["nebula"], locales: [] });
  });

  it("writes nothing when there is nothing to migrate", async () => {
    const { run, release } = harness({ themes: [], locales: [], providers: [] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(release).not.toHaveBeenCalled();
  });

  it("adopts a theme named twice once", async () => {
    const { run, adopt } = harness({ themes: ["aurora", "aurora"], locales: [], providers: [] });
    await run();
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("reports the ids it could not drop from the legacy lists, so the next run drops them", async () => {
    const { run, release, warn } = harness({ themes: ["aurora"], locales: ["ko"], providers: [] });
    release.mockRejectedValueOnce(new Error("settings.json is read-only"));

    const report = await run();

    expect(report.adopted.map((key) => key.name)).toEqual(["aurora", "korean"]);
    const message = "dropping it from the legacy list failed: settings.json is read-only";
    expect(report.failed).toEqual([
      { key: { source: "ave", kind: "theme", name: "aurora" }, message },
      { key: { source: "ave", kind: "language", name: "korean" }, message },
    ]);
    expect(warn).toHaveBeenCalledWith(`legacy content: ${message}`);
  });
});
