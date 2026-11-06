import { describe, expect, it, vi } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { migrateLegacyContent, type LegacyActivations, type LegacyContentKind } from "../legacy-content.js";

function harness(activations: LegacyActivations) {
  const adopt = vi.fn(async (_kind: LegacyContentKind, _name: string) => undefined);
  const warn = vi.fn();
  const installed = vi.fn(async (_kind: LegacyContentKind, _name: string) => false);
  const run = () => migrateLegacyContent({ activations, listed: (_kind, name) => ["openrouter"].includes(name), installed, adopt, log: { warn } });
  return { run, adopt, warn, installed };
}

describe("legacy content activation", () => {
  it("adopts each provider once", async () => {
    const { run, adopt } = harness({ providers: ["openrouter", "openrouter"] });
    expect(await run()).toEqual({ adopted: [{ source: "ave", kind: "provider", name: "openrouter" }], failed: [] });
    expect(adopt.mock.calls).toEqual([["provider", "openrouter"]]);
  });

  it("does not query or adopt packages without provider activations", async () => {
    const { run, installed, adopt } = harness({ providers: [] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(installed).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("reports missing packages without releasing their activation", async () => {
    const { run, adopt, warn } = harness({ providers: ["gone"] });
    expect(await run()).toEqual({ adopted: [], failed: [] });
    expect(adopt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps provider conflict handling", async () => {
    const { run, adopt } = harness({ providers: ["openrouter"] });
    adopt.mockRejectedValue(new MarketplaceError("PACKAGE_ID_CONFLICT", "id already provided"));
    expect(await run()).toEqual({ adopted: [], failed: [] });
  });

  it("reports a failed adoption and retains its activation", async () => {
    const { run, adopt } = harness({ providers: ["openrouter"] });
    adopt.mockRejectedValue(new Error("offline"));
    expect((await run()).failed).toEqual([{ key: { source: "ave", kind: "provider", name: "openrouter" }, message: "offline" }]);
  });

});
