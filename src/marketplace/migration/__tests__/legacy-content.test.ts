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
  it("adopts providers without reinstalling or releasing legacy languages", async () => {
    const { run, adopt, release } = harness({ locales: ["ko"], providers: ["openrouter", "openrouter"] });
    expect(await run()).toEqual({ adopted: [{ source: "ave", kind: "provider", name: "openrouter" }], failed: [] });
    expect(adopt.mock.calls).toEqual([["provider", "openrouter"]]);
    expect(release).not.toHaveBeenCalled();
  });

  it("ignores all legacy locale ids without querying or adopting packages", async () => {
    const { run, installed, adopt, release } = harness({ locales: ["ko", "fr", "unknown"], providers: [] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(installed).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it("reports missing packages without releasing their activation", async () => {
    const { run, adopt, release, warn } = harness({ locales: ["fr"], providers: ["gone"] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(adopt).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps provider conflict handling", async () => {
    const { run, adopt } = harness({ locales: ["ko"], providers: ["openrouter"] });
    adopt.mockRejectedValue(new MarketplaceError("PACKAGE_ID_CONFLICT", "id already provided"));
    expect(await run()).toEqual({ adopted: [], failed: [] });
  });
  it("reports a failed adoption and retains its activation", async () => {
    const { run, adopt, release } = harness({ locales: ["ko"], providers: ["openrouter"] });
    adopt.mockRejectedValue(new Error("offline"));
    expect((await run()).failed).toEqual([{ key: { source: "ave", kind: "provider", name: "openrouter" }, message: "offline" }]);
    expect(release).not.toHaveBeenCalled();
  });


  it("writes nothing without legacy activations", async () => {
    const { run, release } = harness({ locales: [], providers: [] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(release).not.toHaveBeenCalled();
  });
});
