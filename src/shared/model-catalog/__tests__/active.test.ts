import { afterEach, describe, expect, it, vi } from "vitest";
import { activeModelCatalog, installModelCatalog } from "../active.js";
import type { ModelCatalogDocument } from "../types.js";

const bundled = activeModelCatalog();
afterEach(() => installModelCatalog(bundled));

describe("the installed model catalog", () => {
  it("calls a loader once, on first read", () => {
    const document = { ...bundled, sha256: "a".repeat(64) } as ModelCatalogDocument;
    const loader = vi.fn(() => document);
    installModelCatalog(loader);
    expect(loader).not.toHaveBeenCalled();
    expect(activeModelCatalog()).toBe(document);
    expect(activeModelCatalog()).toBe(document);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("is shared by every instance of the module, so a reset registry still sees it", async () => {
    const document = { ...bundled, sha256: "b".repeat(64) } as ModelCatalogDocument;
    installModelCatalog(document);
    vi.resetModules();
    const fresh = await import("../active.js");
    expect(fresh.activeModelCatalog()).toBe(document);
  });
});
