import { describe, expect, it } from "vitest";
import {
  buildModelCatalogDocument,
  formatCatalogJson,
  modelCatalogSha256,
  verifyModelCatalogDocument,
} from "../document.js";
import { MODEL_CATALOG_SCHEMA_VERSION } from "../../../shared/model-catalog/types.js";

const LICENSE = { spdx: "MIT" as const, copyright: "Copyright (c) 2025 example", repository: "https://example.invalid/repo", text: "MIT License\n" };
const SOURCE = { url: "https://example.invalid/api.json", fetchedAt: "2026-01-01T00:00:00Z", rawSha256: "0".repeat(64) };

function build(input: unknown = { alpha: { models: { modelone: { id: "modelone", limit: { context: 1000 } } } } }) {
  return buildModelCatalogDocument({ input, providerIds: ["alpha"], source: SOURCE, license: LICENSE });
}

describe("model catalog document", () => {
  it("names the catalog by its content and records where it came from", () => {
    const { document, diagnostics } = build();
    expect(diagnostics).toEqual([]);
    expect(document.schemaVersion).toBe(MODEL_CATALOG_SCHEMA_VERSION);
    expect(document.provenance).toMatchObject({ source: "models.dev", ...SOURCE, schemaVersion: MODEL_CATALOG_SCHEMA_VERSION });
    expect(document.provenance.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(document.sha256).toBe(modelCatalogSha256(document));
    expect(verifyModelCatalogDocument(document)).toBe(document);
  });

  it("hashes the input's content, not the order its keys were written in", () => {
    const a = build({ alpha: { models: { modelone: { id: "modelone", limit: { context: 1000, output: 10 } } } } }).document;
    const b = build({ alpha: { models: { modelone: { limit: { output: 10, context: 1000 }, id: "modelone" } } } }).document;
    expect(a.provenance.inputSha256).toBe(b.provenance.inputSha256);
    expect(a.sha256).toBe(b.sha256);
  });

  it("refuses a copy whose content no longer matches its name", () => {
    const { document } = build();
    const damaged = structuredClone(document);
    (damaged.providers.alpha!.models.modelone!.limits as { context?: number }).context = 2000;
    expect(() => verifyModelCatalogDocument(damaged)).toThrow(/hashes to/);
  });

  it("refuses another schema version, a missing name, and a missing license", () => {
    const { document } = build();
    expect(() => verifyModelCatalogDocument({ ...document, schemaVersion: 2 })).toThrow(/schema version 2/);
    expect(() => verifyModelCatalogDocument({ ...document, sha256: undefined })).toThrow(/no sha256/);
    expect(() => verifyModelCatalogDocument({ ...document, license: undefined })).toThrow(/license/);
    expect(() => verifyModelCatalogDocument("{}")).toThrow(/not an object/);
  });

  it("lays JSON out one record per line at the given depth and reads back as the same value", () => {
    const value = { b: { y: { q: 1, p: [2, { s: 1, r: 0 }] }, x: {} }, a: 1 };
    const text = formatCatalogJson(value, 2);
    expect(text).toBe('{\n  "a": 1,\n  "b": {\n    "x": {},\n    "y": {"p":[2,{"r":0,"s":1}],"q":1}\n  }\n}\n');
    expect(JSON.parse(text)).toEqual(value);
  });
});
