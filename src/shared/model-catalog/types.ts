/**
 * The model capability catalog: one typed record of what each provider's
 * model can do, generated from external metadata (issue #2501,
 * `docs/design/model-capability-catalog.md`).
 *
 * A fact the source does not state is ABSENT, never a stand-in value: no
 * `0` for an unknown price, no `false` for an unknown capability, no empty
 * list for unknown modalities. A present `0` price means the source lists the
 * price as zero; it is not a claim that the model is free to use.
 *
 * These are public, theoretical limits of a model as a provider publishes it.
 * What a particular endpoint reports about itself, what the user configured,
 * and what the host defaults to are separate answers with their own sources;
 * this file only describes the catalog's.
 */

/** Bumped when the normalized shape below changes. Recorded in provenance. */
export const MODEL_CATALOG_SCHEMA_VERSION = 1;

/** Effort values the source schema admits for a qualitative reasoning control. */
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

/**
 * How a model's reasoning is controlled. A numeric budget and a qualitative
 * effort are different contracts; a model may offer either, both, or only a
 * toggle.
 */
export interface CatalogModelReasoning {
  supported: boolean;
  /** Reasoning can be switched on and off. */
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
  /** Accepts file attachments. */
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

/** Where a catalog came from, enough to reproduce it and to name it in a run record. */
export interface ModelCatalogProvenance {
  source: "models.dev";
  /** The document the input was read from. */
  url: string;
  /** When the input was fetched (ISO-8601). */
  fetchedAt: string;
  /** The response's ETag, when it sent one. */
  etag?: string;
  /** sha256 of the full response body as downloaded. */
  rawSha256: string;
  /**
   * The source repository's default-branch head when the input was fetched.
   * The deployed document is built from that repository but is not stamped
   * with a commit, so this is the closest revision, not a proven one.
   */
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

/** The normalized catalog document: the bundled snapshot and every refreshed copy. */
export interface ModelCatalogDocument {
  schemaVersion: number;
  provenance: ModelCatalogProvenance;
  license: ModelCatalogLicense;
  providers: Record<string, CatalogProvider>;
  /**
   * sha256 over the canonical JSON of `schemaVersion`, `license` and
   * `providers` — the catalog's content, not its provenance. Names the facts a
   * run used in its record and lets a reader reject a damaged copy; two
   * downloads of unchanged data share it.
   */
  sha256: string;
}

/** `ave:llm:get-model-catalog`: the catalog main resolves against, or the frame refusal. */
export type ModelCatalogIpcResult =
  | { ok: true; catalog: ModelCatalogDocument }
  | { ok: false; error: "unauthorized-frame" | "catalog-unavailable" };
