import { canonicalStringify } from "../../shared/canonical-json.js";
import { normalizeModelsDevProviders, type CatalogDiagnostic } from "../../shared/model-catalog/normalize.js";
import {
  MODEL_CATALOG_SCHEMA_VERSION,
  type ModelCatalogDocument,
  type ModelCatalogLicense,
  type ModelCatalogProvenance,
} from "../../shared/model-catalog/types.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import { modelCatalogSha256 } from "./document.js";

export type ModelCatalogSource = Omit<ModelCatalogProvenance, "source" | "inputSha256" | "schemaVersion">;

/** The caller decides whether normalization diagnostics are acceptable. */
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

/** Keep canonical model records on one line for reviewable diffs and terminate with a newline. */
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
