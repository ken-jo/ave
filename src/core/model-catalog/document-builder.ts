/** Normalize and format catalog documents for publication. */
import { canonicalStringify } from "../../shared/canonical-json.js";
import { normalizeModelsDevProviders, type CatalogDiagnostic } from "../../shared/model-catalog/normalize.js";
import {
  MODEL_CATALOG_SCHEMA_VERSION,
  type ModelCatalogDocument,
  type ModelCatalogLicense,
  type ModelCatalogProvenance,
} from "../../shared/model-catalog/types.js";
import { modelCatalogSha256, sha256Hex } from "./document.js";

/** What the generator knows about where its input came from; the rest of the provenance is computed. */
export type ModelCatalogSource = Omit<ModelCatalogProvenance, "source" | "inputSha256" | "schemaVersion">;

/** Normalize pruned provider data; the caller decides whether diagnostics are acceptable. */
export function buildModelCatalogDocument(args: {
  input: unknown;
  providerIds: readonly string[];
  source: ModelCatalogSource;
  license: ModelCatalogLicense;
}): { document: ModelCatalogDocument; diagnostics: CatalogDiagnostic[] } {
  const { providers, diagnostics } = normalizeModelsDevProviders(args.input, args.providerIds);
  const content: Omit<ModelCatalogDocument, "sha256"> = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    provenance: {
      source: "models.dev",
      ...args.source,
      inputSha256: sha256Hex(canonicalStringify(args.input)),
      schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    },
    license: args.license,
    providers,
  };
  return { document: { ...content, sha256: modelCatalogSha256(content) }, diagnostics };
}

/**
 * Canonical JSON laid out for review: objects shallower than `compactDepth`
 * are indented with one key per line, and every value at that depth is one
 * canonical line. With the depth at a model record, a refresh's diff is one
 * line per changed model instead of one line per changed field of a 2 MB
 * file, or one line for the whole file. Ends with a newline.
 */
export function formatCatalogJson(value: unknown, compactDepth: number): string {
  const layout = (node: unknown, depth: number): string => {
    if (depth >= compactDepth || node === null || typeof node !== "object" || Array.isArray(node)) {
      return canonicalStringify(node);
    }
    const object = node as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    if (keys.length === 0) return "{}";
    const pad = "  ".repeat(depth + 1);
    const lines = keys.map((key) => `${pad}${JSON.stringify(key)}: ${layout(object[key], depth + 1)}`);
    return `{\n${lines.join(",\n")}\n${"  ".repeat(depth)}}`;
  };
  return `${layout(value, 0)}\n`;
}
