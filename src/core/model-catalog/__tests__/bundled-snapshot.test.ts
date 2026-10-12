/**
 * The committed snapshot, held to the committed input that generates it.
 *
 * `check:model-catalog` holds the file to the generator's output; this does
 * the same inside the suite, and checks what the bytes alone cannot: the
 * snapshot verifies under its own name, every mapped provider is present,
 * the input carries no field the normalizer does not read, and the license
 * travels with the data. (`THIRD-PARTY-NOTICES.md` reproduces the same text;
 * it is documentation, which the suite does not read.)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG_PATHS,
  generateModelCatalog,
  modelCatalogPricingReport,
} from "../../../../scripts/lib/model-catalog.js";
import { verifyModelCatalogDocument } from "../document.js";
import { MODELS_DEV_MODEL_FIELDS } from "../../../shared/model-catalog/normalize.js";
import { catalogProviderIds } from "../../../shared/model-catalog/provider-map.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf-8").replace(/\r\n/g, "\n");

describe("bundled model catalog", () => {
  const generated = generateModelCatalog(ROOT);

  it("is exactly what the committed input generates", () => {
    expect(generated.diagnostics).toEqual([]);
    expect(read(MODEL_CATALOG_PATHS.snapshot)).toBe(generated.text);
  });

  it("verifies under its own name and records its input", () => {
    const document = verifyModelCatalogDocument(JSON.parse(read(MODEL_CATALOG_PATHS.snapshot)));
    expect(document.provenance.source).toBe("models.dev");
    expect(document.provenance.url).toBe("https://models.dev/api.json");
    expect(document.provenance.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(document.provenance.fetchedAt)).not.toBeNaN();
  });

  it("has every provider a vendor maps to, each with models", () => {
    expect(Object.keys(generated.document.providers)).toEqual(catalogProviderIds());
    for (const [provider, { models }] of Object.entries(generated.document.providers)) {
      expect(Object.keys(models).length, provider).toBeGreaterThan(0);
    }
  });

  it("commits only the fields the normalizer reads", () => {
    const input = JSON.parse(read(MODEL_CATALOG_PATHS.input)) as Record<string, { models: Record<string, Record<string, unknown>> }>;
    const carried = new Set<string>(MODELS_DEV_MODEL_FIELDS);
    for (const { models } of Object.values(input)) {
      for (const model of Object.values(models)) {
        expect(Object.keys(model).filter((field) => !carried.has(field))).toEqual([]);
      }
    }
  });

  it("carries the source's MIT license with the data", () => {
    const license = read(MODEL_CATALOG_PATHS.license);
    expect(generated.document.license).toEqual({
      spdx: "MIT",
      copyright: "Copyright (c) 2025 models.dev",
      repository: "https://github.com/anomalyco/models.dev",
      text: license,
    });
  });

  it("reports the hand-kept rows the catalog cannot replace", () => {
    const report = modelCatalogPricingReport(generated.document);
    expect(report).toContain("## Rows with no catalog entry");
    // Self-hosted endpoints map to no catalog provider, so their windows stay host-owned.
    expect(report).toContain("| openai-compatible | Qwen3.6-35B-A3B-NVFP4 | 262144 | 0 / 0 |");
    expect(report).toContain("| claude | claude-sonnet-4-6 | contextWindow1MBeta | 1000000 |");
  });
});
