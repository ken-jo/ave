import { afterEach, describe, expect, it } from "vitest";
import { installRendererModelCatalog } from "../model-catalog-bootstrap.js";
import { activeModelCatalog, installModelCatalog } from "../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";

const installed = activeModelCatalog();
afterEach(() => installModelCatalog(installed));

describe("installRendererModelCatalog", () => {
  it("installs the catalog main hands over, so the renderer resolves against main's copy", async () => {
    const fromMain = { ...installed, sha256: "f".repeat(64) } as ModelCatalogDocument;
    await installRendererModelCatalog({ getModelCatalog: async () => ({ ok: true, catalog: fromMain }) });
    expect(activeModelCatalog()).toBe(fromMain);
  });

  it("fails rather than mounting against no catalog when main refuses", async () => {
    await expect(
      installRendererModelCatalog({ getModelCatalog: async () => ({ ok: false, error: "unauthorized-frame" }) }),
    ).rejects.toThrow(/refused the model catalog/);
    expect(activeModelCatalog()).toBe(installed);
  });
});
