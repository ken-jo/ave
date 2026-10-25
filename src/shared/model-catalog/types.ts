/**
 * Model capability catalog (`docs/design/model-capability-catalog.md`).
 * Unstated facts stay absent; a listed zero price does not mean free use.
 */

/** Bumped when the normalized shape below changes. Recorded in provenance. */
export const MODEL_CATALOG_SCHEMA_VERSION = 1;

export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
] as const;
export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];

interface CatalogModelLimits {
  /** Total context window in tokens. */
  context?: number;
  /** Largest prompt, when the provider caps it below the context window. */
  input?: number;
  /** Largest completion. */
  output?: number;
}

interface CatalogModelModalities {
  input: string[];
  output: string[];
}

/** Numeric budget, qualitative effort, and toggle controls are independent model contracts. */
export interface CatalogModelReasoning {
  supported: boolean;
  toggle?: true;
  /** The qualitative levels the model accepts, in the source's order. */
  effort?: ReasoningEffortValue[];
  /** A numeric thinking budget, with its bounds when the source states them. */
  budgetTokens?: { min?: number; max?: number };
}

/** A price tier that replaces the base rates once the prompt exceeds `afterInputTokens`. */
export interface CatalogCostTier {
  afterInputTokens: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** USD per million tokens. */
export interface CatalogModelCost {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: CatalogCostTier[];
}

export interface CatalogModel {
  /** The provider's model id, exactly as the provider spells it. */
  id: string;
  name?: string;
  family?: string;
  /** The originating lab's `<lab>/<model>` id for a model served by another provider. */
  canonicalId?: string;
  limits: CatalogModelLimits;
  modalities?: CatalogModelModalities;
  attachment?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  reasoning?: CatalogModelReasoning;
  /** Interleaved reasoning; the object form names the response field that carries it. */
  interleaved?: true | { field: string };
  cost?: CatalogModelCost;
  status?: "alpha" | "beta" | "deprecated";
  releaseDate?: string;
}

export interface CatalogProvider {
  models: Record<string, CatalogModel>;
}

export interface ModelCatalogProvenance {
  source: "models.dev";
  url: string;
  /** When the input was fetched (ISO-8601). */
  fetchedAt: string;
  /** The response's ETag, when it sent one. */
  etag?: string;
  /** sha256 of the full response body as downloaded. */
  rawSha256: string;
  /** Fetched repository head is approximate provenance; deployed documents are not stamped with that revision. */
  upstreamHeadAtFetch?: string;
  /** Git blob id of the source's schema definition at that head. */
  upstreamSchemaBlob?: string;
  /** sha256 of the pruned input the generator read. */
  inputSha256: string;
  /** {@link MODEL_CATALOG_SCHEMA_VERSION} of the normalized document. */
  schemaVersion: number;
}

export interface ModelCatalogLicense {
  spdx: "MIT";
  copyright: string;
  repository: string;
  /** The full license text, carried with the data it covers. */
  text: string;
}

export interface ModelCatalogDocument {
  schemaVersion: number;
  provenance: ModelCatalogProvenance;
  license: ModelCatalogLicense;
  providers: Record<string, CatalogProvider>;
  /** Hash canonical content without provenance so unchanged downloads retain identity and damaged copies can be rejected. */
  sha256: string;
}

/** Managed refresh policy off includes unreadable policy; null leaves the user in control. */
export type ModelCatalogIpcResult =
  | { ok: true; catalog: ModelCatalogDocument; refreshPolicy: "off" | null }
  | { ok: false; error: "unauthorized-frame" | "catalog-unavailable" };
