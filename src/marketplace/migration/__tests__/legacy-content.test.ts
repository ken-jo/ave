import { describe, expect, it, vi } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { migrateLegacyContent, type LegacyActivations, type LegacyContentKind } from "../legacy-content.js";

function harness(activations: LegacyActivations) {
  const adopt = vi.fn(async (_kind: LegacyContentKind, _name: string) => undefined);
  const release = vi.fn(async () => undefined);
  const warn = vi.fn();
  const installed = vi.fn(async (_kind: LegacyContentKind, _name: string) => false);
  const run = () => migrateLegacyContent({ activations, listed: (_kind, name) => ["korean", "openrouter"].includes(name), installed, adopt, release, log: { warn } });
  return { run, adopt, release, warn, installed };
}

describe("legacy content activation", () => {
  it("adopts languages and providers and releases only legacy locales", async () => {
    const { run, adopt, release } = harness({ locales: ["ko"], providers: ["openrouter", "openrouter"] });
    expect(await run()).toEqual({ adopted: [{ source: "ave", kind: "language", name: "korean" }, { source: "ave", kind: "provider", name: "openrouter" }], failed: [] });
    expect(adopt.mock.calls).toEqual([["language", "korean"], ["provider", "openrouter"]]);
    expect(release).toHaveBeenCalledWith({ locales: ["ko"] });
  });

  it("releases a locale already provided by an installed package", async () => {
    const { run, installed, adopt, release } = harness({ locales: ["ko"], providers: [] });
    installed.mockResolvedValue(true);
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(adopt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ locales: ["ko"] });
  });

  it("reports missing packages without releasing their activation", async () => {
    const { run, adopt, release, warn } = harness({ locales: ["fr"], providers: ["gone"] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(adopt).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("releases a locale another package already provides", async () => {
    const { run, adopt, release } = harness({ locales: ["ko"], providers: [] });
    adopt.mockRejectedValue(new MarketplaceError("PACKAGE_ID_CONFLICT", "locale already provided"));
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(release).toHaveBeenCalledWith({ locales: ["ko"] });
  });

  it("reports a failed adoption and retains its activation", async () => {
    const { run, adopt, release } = harness({ locales: ["ko"], providers: [] });
    adopt.mockRejectedValue(new Error("offline"));
    expect((await run()).failed).toEqual([{ key: { source: "ave", kind: "language", name: "korean" }, message: "offline" }]);
    expect(release).not.toHaveBeenCalled();
  });

  it("reports a failed legacy list write for the next boot to retry", async () => {
    const { run, release } = harness({ locales: ["ko"], providers: [] });
    release.mockRejectedValue(new Error("disk full"));
    expect((await run()).failed).toEqual([{ key: { source: "ave", kind: "language", name: "korean" }, message: "dropping it from the legacy list failed: disk full" }]);
  });

  it("writes nothing without legacy activations", async () => {
    const { run, release } = harness({ locales: [], providers: [] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(release).not.toHaveBeenCalled();
  });
});
