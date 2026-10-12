import { describe, expect, it } from "vitest";
import { lookupCatalogModel, resolveCatalogKey } from "../resolve.js";
import type { CatalogModel, ModelCatalogDocument } from "../types.js";

const entry = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, limits: { context: 1000 }, ...extra });

function catalog(providers: Record<string, CatalogModel[]>): Pick<ModelCatalogDocument, "providers"> {
  return {
    providers: Object.fromEntries(
      Object.entries(providers).map(([provider, models]) => [provider, { models: Object.fromEntries(models.map((model) => [model.id, model])) }]),
    ),
  };
}

describe("resolveCatalogKey", () => {
  it("finds an id exactly through the vendor's provider", () => {
    const hit = resolveCatalogKey(catalog({ anthropic: [entry("modelone")] }), "claude", "modelone");
    expect(hit).toMatchObject({ provider: "anthropic", id: "modelone", match: "exact" });
  });

  it("looks only in the providers the vendor maps to", () => {
    expect(resolveCatalogKey(catalog({ openai: [entry("modelone")] }), "claude", "modelone")).toBeUndefined();
  });

  it("tries the vendor's providers in the map's order", () => {
    const both = catalog({ "google-vertex": [entry("modelone")], "google-vertex-anthropic": [entry("modelone")] });
    expect(resolveCatalogKey(both, "vertex-ai", "modelone")?.provider).toBe("google-vertex");
    const second = catalog({ "google-vertex": [], "google-vertex-anthropic": [entry("modeltwo")] });
    expect(resolveCatalogKey(second, "vertex-ai", "modeltwo")?.provider).toBe("google-vertex-anthropic");
  });

  it("strips a release-date suffix in either spelling", () => {
    const models = catalog({ openai: [entry("modelone")] });
    expect(resolveCatalogKey(models, "openai", "modelone-20250101")).toMatchObject({ id: "modelone", match: "date-suffix" });
    expect(resolveCatalogKey(models, "openai", "modelone-2025-01-01")).toMatchObject({ id: "modelone", match: "date-suffix" });
  });

  it("prefers a dated entry the catalog lists over the undated one", () => {
    const models = catalog({ openai: [entry("modelone"), entry("modelone-20250101")] });
    expect(resolveCatalogKey(models, "openai", "modelone-20250101")).toMatchObject({ id: "modelone-20250101", match: "exact" });
  });

  it("folds case and version separators when exactly one entry matches", () => {
    const models = catalog({ kilo: [entry("model-4.6")] });
    expect(resolveCatalogKey(models, "kilo", "Model-4-6")).toMatchObject({ id: "model-4.6", match: "folded" });
  });

  it("refuses a folded match that names two entries", () => {
    const models = catalog({ kilo: [entry("model-4.6"), entry("model-4-6")] });
    expect(resolveCatalogKey(models, "kilo", "MODEL-4-6")).toBeUndefined();
  });

  it("ignores a path prefix on either side when exactly one entry matches", () => {
    const prefixed = catalog({ kilo: [entry("lab/modelone"), entry("lab/modeltwo")] });
    expect(resolveCatalogKey(prefixed, "kilo", "modelone")).toMatchObject({ id: "lab/modelone", match: "unprefixed" });
    const bare = catalog({ requesty: [entry("modelone")] });
    expect(resolveCatalogKey(bare, "requesty", "lab/modelone")).toMatchObject({ id: "modelone", match: "unprefixed" });
    const twoLabs = catalog({ kilo: [entry("lab/modelone"), entry("other/modelone")] });
    expect(resolveCatalogKey(twoLabs, "kilo", "modelone")).toBeUndefined();
  });

  it("follows an Ave alias to the id the catalog lists", () => {
    const models = catalog({ anthropic: [entry("modeltwo")] });
    expect(resolveCatalogKey(models, "claude", "modelone", { claude: { modelone: "modeltwo" } })).toMatchObject({ id: "modeltwo", match: "alias" });
    expect(resolveCatalogKey(models, "claude", "modelone", { claude: { modelone: "modelthree" } })).toBeUndefined();
    expect(resolveCatalogKey(models, "claude", "constructor", { claude: {} })).toBeUndefined();
  });

  it("drops a Vertex version tag from either side when exactly one entry matches", () => {
    const models = catalog({ "google-vertex-anthropic": [entry("modelone@default"), entry("modeltwo@20250101"), entry("modeltwo@20250601")] });
    expect(resolveCatalogKey(models, "vertex-ai", "modelone")).toMatchObject({ id: "modelone@default", match: "version-tag" });
    expect(resolveCatalogKey(models, "vertex-ai", "modelone@20260101")).toMatchObject({ id: "modelone@default", match: "version-tag" });
    expect(resolveCatalogKey(models, "vertex-ai", "modeltwo@20250601")).toMatchObject({ id: "modeltwo@20250601", match: "exact" });
    // Two tagged entries of one model do not say which the untagged id is.
    expect(resolveCatalogKey(models, "vertex-ai", "modeltwo")).toBeUndefined();
  });

  it("finds an entry by the originating lab's id", () => {
    const models = catalog({ openrouter: [entry("lab/modelone-preview", { canonicalId: "lab/modelone" })] });
    expect(resolveCatalogKey(models, "openrouter", "lab/modelone")).toMatchObject({ id: "lab/modelone-preview", match: "canonical" });
  });

  it("never matches a self-hosted or local vendor by name", () => {
    const everywhere = catalog({ openai: [entry("modelone")], anthropic: [entry("modelone")] });
    for (const vendor of ["openai-compatible", "ollama", "lmstudio", "not-a-vendor"]) {
      expect(resolveCatalogKey(everywhere, vendor, "modelone"), vendor).toBeUndefined();
    }
  });

  it("does not read an inherited property as a model", () => {
    expect(resolveCatalogKey(catalog({ openai: [] }), "openai", "constructor")).toBeUndefined();
    expect(resolveCatalogKey(catalog({ openai: [] }), "toString", "modelone")).toBeUndefined();
  });
});

describe("lookupCatalogModel", () => {
  const models = catalog({ openai: [entry("modelone")], openrouter: [entry("lab/modeltwo")] });

  it("looks a user-named entry up exactly, provider first", () => {
    expect(lookupCatalogModel(models, "openai/modelone")).toMatchObject({ provider: "openai", id: "modelone", match: "named" });
    expect(lookupCatalogModel(models, "openrouter/lab/modeltwo")).toMatchObject({ provider: "openrouter", id: "lab/modeltwo" });
  });

  it("answers nothing for a malformed or unknown name", () => {
    for (const named of ["modelone", "/modelone", "openai/", "openai/MODELONE", "nowhere/modelone"]) {
      expect(lookupCatalogModel(models, named), named).toBeUndefined();
    }
  });
});
