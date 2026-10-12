/**
 * Build, name and check a normalized model catalog document.
 *
 * The generator writes the bundled snapshot with these functions, and the
 * refresh (issue #2501 slice 6) writes each refreshed copy with the same
 * ones, so a catalog is the same bytes and the same `sha256` whichever
 * produced it. The hash is over the canonical JSON of every other field —
 * keys sorted, arrays in order — so it names the catalog's content, not the
 * whitespace a file happens to carry.
 */
import { createHash } from "node:crypto";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { normalizeModelsDevProviders, type CatalogDiagnostic } from "../../shared/model-catalog/normalize.js";
import {
  MODEL_CATALOG_SCHEMA_VERSION,
  type ModelCatalogDocument,
  type ModelCatalogLicense,
  type ModelCatalogProvenance,
} from "../../shared/model-catalog/types.js";

/** What the generator knows about where its input came from; the rest of the provenance is computed. */
export type ModelCatalogSource = Omit<ModelCatalogProvenance, "source" | "inputSha256" | "schemaVersion">;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** The catalog's name: sha256 over the canonical JSON of the document without its own hash. */
export function modelCatalogSha256(document: Omit<ModelCatalogDocument, "sha256">): string {
  const { sha256: _ignored, ...content } = document as ModelCatalogDocument;
  return sha256Hex(canonicalStringify(content));
}

/**
 * Normalize a pruned models.dev input into a catalog document. A diagnostic
 * is returned, not thrown: the caller decides whether a dropped model or
 * field is acceptable (the generator prints them; the refresh records them).
 */
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
 * Reject a document that is not this schema version or whose content does
 * not hash to its stated name. Throws with the reason; a damaged or foreign
 * catalog is never read as a partial one.
 */
export function verifyModelCatalogDocument(value: unknown): ModelCatalogDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model catalog is not an object");
  }
  const document = value as Partial<ModelCatalogDocument>;
  if (document.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw new Error(`model catalog schema version ${String(document.schemaVersion)} is not ${MODEL_CATALOG_SCHEMA_VERSION}`);
  }
  if (typeof document.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(document.sha256)) {
    throw new Error("model catalog has no sha256");
  }
  if (document.provenance?.source !== "models.dev" || document.license?.spdx !== "MIT" || typeof document.providers !== "object" || document.providers === null) {
    throw new Error("model catalog is missing its provenance, license or providers");
  }
  const actual = modelCatalogSha256(document as ModelCatalogDocument);
  if (actual !== document.sha256) {
    throw new Error(`model catalog content hashes to ${actual}, not its stated ${document.sha256}`);
  }
  return document as ModelCatalogDocument;
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
