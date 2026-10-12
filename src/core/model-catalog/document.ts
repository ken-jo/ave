/**
 * Name and check a normalized model catalog document.
 *
 * The hash is over the canonical JSON — keys sorted, arrays in
 * order — of what the catalog SAYS: its schema version, its license and its
 * providers. Provenance is carried beside it and left out of the name, so two
 * downloads of unchanged data (a new `fetchedAt`, a CDN's new ETag) are the
 * same catalog in a run record and in the cache, not two.
 */
import { createHash } from "node:crypto";
import { canonicalStringify } from "../../shared/canonical-json.js";
import {
  MODEL_CATALOG_SCHEMA_VERSION,
  type ModelCatalogDocument,
  type ModelCatalogProvenance,
} from "../../shared/model-catalog/types.js";

/** Hash the same canonical bytes for readers and producers. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** The catalog's name: sha256 over the canonical JSON of its schema version, license and providers. */
export function modelCatalogSha256(document: Pick<ModelCatalogDocument, "schemaVersion" | "license" | "providers">): string {
  const { schemaVersion, license, providers } = document;
  return sha256Hex(canonicalStringify({ schemaVersion, license, providers }));
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^[0-9a-f]{40}$/;

/**
 * What is wrong with a provenance record's shape, or `undefined`. Provenance
 * is outside the hash, so a copy could carry any provenance under a valid
 * name; the shape check keeps what a reader reports about a copy's origin
 * well-formed. A run record cites the catalog by `sha256` alone.
 */
function provenanceShapeFault(provenance: ModelCatalogProvenance): string | undefined {
  const optional = (value: unknown, pattern: RegExp): boolean => value === undefined || (typeof value === "string" && pattern.test(value));
  if (typeof provenance.url !== "string" || !provenance.url.startsWith("https://")) return "has no https url";
  if (typeof provenance.fetchedAt !== "string" || Number.isNaN(Date.parse(provenance.fetchedAt))) return "has no fetch time";
  if (provenance.etag !== undefined && typeof provenance.etag !== "string") return "has a malformed etag";
  if (typeof provenance.rawSha256 !== "string" || !SHA256.test(provenance.rawSha256)) return "has no download sha256";
  if (typeof provenance.inputSha256 !== "string" || !SHA256.test(provenance.inputSha256)) return "has no input sha256";
  if (!optional(provenance.upstreamHeadAtFetch, GIT_OBJECT)) return "has a malformed upstream head";
  if (!optional(provenance.upstreamSchemaBlob, GIT_OBJECT)) return "has a malformed schema blob";
  if (provenance.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) return `names schema version ${String(provenance.schemaVersion)}`;
  return undefined;
}

/**
 * Reject a document that is not this schema version, whose provenance is
 * malformed, or whose content does not hash to its stated name. Throws with the reason; a damaged or foreign
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
  const provenanceFault = provenanceShapeFault(document.provenance);
  if (provenanceFault) throw new Error(`model catalog provenance ${provenanceFault}`);
  const actual = modelCatalogSha256(document as ModelCatalogDocument);
  if (actual !== document.sha256) {
    throw new Error(`model catalog content hashes to ${actual}, not its stated ${document.sha256}`);
  }
  return document as ModelCatalogDocument;
}
