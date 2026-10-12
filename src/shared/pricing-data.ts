/**
 * Shared LLM pricing + context-window catalog — single source of truth.
 *
 * Imported by:
 *   - `engine/llm/pricing.ts` (Node-side, layers env-override on top)
 *   - `engine/auto-compact.ts:getModelContextWindow` (engine-side ctx lookup)
 *   - `renderer.tsx` / `ui/renderer/hooks/use-context-budget.ts` (UI denominator)
 *
 * Two distinct values per model:
 *   - `contextWindow`        — default API tier (no beta opt-in).
 *   - `contextWindow1MBeta`  — larger window unlocked by Anthropic's
 *                              `context-1m-2025-08-07` beta header. The
 *                              VercelUnifiedProvider auto-sends this header
 *                              for any Claude model that defines this field
 *                              (`engine/llm/vercel/adapter.ts`), so callers
 *                              should treat the beta value as the *effective*
 *                              window when present.
 *
 * Cache prices:
 *   - OpenAI/Azure-compatible prompt cache reads use `cacheReadPer1M` when
 *     the provider publishes a cached-input price.
 *   - Anthropic prompt cache reads/writes use `cacheReadPer1M` /
 *     `cacheWritePer1M`; omitted values derive from public ratios at compute
 *     time (read ~0.1× input, write 5m TTL ~1.25× input).
 *
 * IMPORTANT: this module must stay pure — no `process.env`, no Node-only
 * imports. All env-override logic lives in `engine/llm/pricing.ts`.
 *
 * Pricing source: list prices announced by each vendor. A zero row is not a
 * price: `lookupBillablePricingOptional` skips it, and the price resolution
 * (`shared/model-pricing.ts`) reads this table only for a model the model
 * catalog does not price.
 * Context window source: vendor model docs. Last verified 2026-10-08 (Claude
 * rows); other vendors' rows were last verified 2026-05.
 */

/**
 * The vendors this table prices, in the order a picker should offer them.
 *
 * One list: the type is derived from it and the membership test reads it, so a
 * vendor cannot be addable in the UI but unrecognised by `toPricingVendor`, or
 * vice versa. It used to be a union and a matching `Set` written out twice.
 */
export const PRICING_VENDORS = [
  "claude",
  "openai",
  "gemini",
  "copilot",
  "azure-foundry",
  "vertex-ai",
  "openai-compatible",
] as const;

export type PricingVendor = (typeof PRICING_VENDORS)[number];

const PRICING_VENDOR_SET = new Set<string>(PRICING_VENDORS);

export function toPricingVendor(vendor: string): PricingVendor {
  return PRICING_VENDOR_SET.has(vendor)
    ? vendor as PricingVendor
    : "openai-compatible";
}

/**
 * A price tier: once a request's prompt exceeds `afterInputTokens`, the rates
 * it states replace the base rates for that whole request. A rate the tier
 * does not state keeps the base rate.
 */
export interface TokenRateTier {
  afterInputTokens: number;
  inputPer1M?: number;
  outputPer1M?: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

/** What one request costs per token: $ per 1M tokens, nothing about capacity. */
export interface TokenRates {
  inputPer1M: number;
  outputPer1M: number;
  /**
   * Cache read price ($/1M tokens). Anthropic bills prompt-cache hits as a
   * separate additive line; OpenAI/Azure-compatible providers report cached
   * tokens as a subset of prompt tokens and price that subset at this rate
   * when published. Undefined → caller treats cache reads as ordinary input.
   */
  cacheReadPer1M?: number;
  /**
   * Cache write price ($/1M tokens). Anthropic only — 5m TTL ~1.25× input,
   * 1h TTL ~2× input. This single field assumes the dominant TTL.
   * Undefined → caller treats cache writes as ordinary input.
   */
  cacheWritePer1M?: number;
  /**
   * Reasoning-token price ($/1M tokens), when the model bills reasoning apart
   * from the rest of its output. The reasoning tokens a provider reports are
   * part of the output count; they are priced at this rate and the remainder
   * at `outputPer1M`. Undefined → reasoning is ordinary output.
   */
  reasoningPer1M?: number;
  /** A thinking-mode rate covers all output when the request reports positive reasoning tokens. */
  reasoningRateScope?: "output";
  /** Prompt-size tiers, ascending by `afterInputTokens` (the model catalog's `cost.tiers`). */
  tiers?: readonly TokenRateTier[];
  /**
   * Long-context input surcharge — input tokens BEYOND `surchargeInputThreshold`
   * trigger a session-wide price multiplier on BOTH input + output. The
   * hand-kept table states OpenAI's gpt-5.4 / gpt-5.4-pro this way: when prompt
   * > 272K, the full request is billed at 2x input + 1.5x output (issue #900).
   * The model catalog states the same prices as a tier; the table's form goes
   * with the table (issue #2501, slice 7).
   */
  surchargeInputThreshold?: number;
  surchargeInputMultiplier?: number;
  surchargeOutputMultiplier?: number;
}

/** A hand-kept table row: token rates plus the context window metadata the table also carries. */
export interface ModelPricing extends TokenRates {
  /** Default API tier context window in tokens. */
  contextWindow: number;
  /**
   * Beta-tier context window (Anthropic `context-1m-2025-08-07`). When
   * defined, the adapter auto-sends the beta header and the model delivers
   * this larger window. Renderer / engine MUST resolve to this value when
   * present — see {@link effectiveContextWindow}.
   */
  contextWindow1MBeta?: number;
  tpmDefault?: number;
}

/** Default pricing + context catalog. */
export const DEFAULT_PRICING: Record<PricingVendor, Record<string, ModelPricing>> = {
  // ── Anthropic Claude ──────────────────────────────────────────────────────
  // Pricing: https://platform.claude.com/docs/en/about-claude/pricing — verified 2026-10-08.
  // Context: 4.6 family supports 1M via `context-1m-2025-08-07` beta; Opus 4.7+,
  // Sonnet 5+ and Fable 5+ serve 1M by default at standard pricing (no header).
  // Cache hits are 0.1× input except Opus 5.5 / Sonnet 5.5 (0.05×) and
  // Fable 5.1 (0.025×) — those carry an explicit `cacheReadPer1M` because
  // `anthropicCacheRates` would otherwise derive 0.1×. Cache writes stay at the
  // derived 1.25× (5m TTL) for every row below.
  // Not listed: Haiku 5.5 — its price depends on prompt length (≤100K vs above),
  // which the model catalog states as a tier and `computeCost` applies.
  claude: {
    "claude-fable-5-1":            { inputPer1M: 10,   outputPer1M: 50, contextWindow: 1_000_000, cacheReadPer1M: 0.25 },
    "claude-fable-5":              { inputPer1M: 10,   outputPer1M: 50, contextWindow: 1_000_000 },
    "claude-opus-5-5":             { inputPer1M: 4,    outputPer1M: 20, contextWindow: 1_000_000, cacheReadPer1M: 0.2 },
    "claude-opus-5":               { inputPer1M: 5,    outputPer1M: 25, contextWindow: 1_000_000 },
    "claude-opus-4-8":             { inputPer1M: 5,    outputPer1M: 25, contextWindow: 1_000_000 },
    "claude-opus-4-7":             { inputPer1M: 5,    outputPer1M: 25, contextWindow: 1_000_000 },
    "claude-sonnet-5-5":           { inputPer1M: 2,    outputPer1M: 10, contextWindow: 1_000_000, cacheReadPer1M: 0.1 },
    "claude-sonnet-5":             { inputPer1M: 2,    outputPer1M: 10, contextWindow: 1_000_000 },
    "claude-sonnet-4-6":           { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-sonnet-4-5":           { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-sonnet-4-20250514":    { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-opus-4-6":             { inputPer1M: 5,    outputPer1M: 25, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-opus-4-5":             { inputPer1M: 5,    outputPer1M: 25, contextWindow: 200_000 },
    "claude-opus-4-20250514":      { inputPer1M: 15,   outputPer1M: 75, contextWindow: 200_000 },
    "claude-haiku-4-5":            { inputPer1M: 1,    outputPer1M: 5,  contextWindow: 200_000 },
    "claude-haiku-4-5-20251001":   { inputPer1M: 1,    outputPer1M: 5,  contextWindow: 200_000 },
    "claude-3-5-sonnet-20241022":  { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-3-5-haiku-20241022":   { inputPer1M: 1,    outputPer1M: 5,  contextWindow: 200_000 },
    "claude-3-opus-20240229":      { inputPer1M: 15,   outputPer1M: 75, contextWindow: 200_000 },
    "claude-3-sonnet-20240229":    { inputPer1M: 3,    outputPer1M: 15, contextWindow: 200_000 },
    "claude-3-haiku-20240307":     { inputPer1M: 0.25, outputPer1M: 1.25, contextWindow: 200_000 },
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // Pricing source: https://platform.openai.com/docs/pricing
  // Unknown variant pricing intentionally left at 0 — env override expected.
  openai: {


    //


    //


    "gpt-5.4":                     { inputPer1M: 2.5,  outputPer1M: 15,  cacheReadPer1M: 0.25,  contextWindow: 1_050_000, surchargeInputThreshold: 272_000, surchargeInputMultiplier: 2,   surchargeOutputMultiplier: 1.5 },
    "gpt-5.4-mini":                { inputPer1M: 0.75, outputPer1M: 4.5, cacheReadPer1M: 0.075, contextWindow:   400_000, tpmDefault:    200_000 },
    "gpt-5.4-nano":                { inputPer1M: 0.2,  outputPer1M: 1.25, contextWindow:  400_000, tpmDefault:    200_000 },
    "gpt-5.4-pro":                 { inputPer1M: 30,   outputPer1M: 180, contextWindow: 1_100_000, surchargeInputThreshold: 272_000, surchargeInputMultiplier: 2,   surchargeOutputMultiplier: 1.5 },
    "gpt-5.3":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.3-codex":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.2":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.2-codex":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-reasoning":           { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-pro":                 { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-codex":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-codex-mini":          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5.1-codex-max":           { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-5":                       { inputPer1M: 1.25, outputPer1M: 10, contextWindow:   400_000 },
    "gpt-5-mini":                  { inputPer1M: 1.25, outputPer1M: 10, contextWindow:   400_000 },
    "gpt-5-nano":                  { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   400_000 },
    "gpt-4.1":                     { inputPer1M: 2,    outputPer1M: 8,  contextWindow: 1_000_000 },
    "gpt-4.1-mini":                { inputPer1M: 0.4,  outputPer1M: 1.6, contextWindow: 1_000_000 },
    "gpt-4.1-nano":                { inputPer1M: 0,    outputPer1M: 0,  contextWindow: 1_000_000 },
    "gpt-4.1-2025-04-14":          { inputPer1M: 2,    outputPer1M: 8,  contextWindow: 1_000_000 },
    "o3":                          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o3-2025-04-16":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o4-mini":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o4-mini-2025-04-24":          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o1":                          { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   200_000 },
    "o1-mini":                     { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4o":                      { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4o-mini":                 { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4-turbo":                 { inputPer1M: 0,    outputPer1M: 0,  contextWindow:   128_000 },
    "gpt-4-32k":                   { inputPer1M: 0,    outputPer1M: 0,  contextWindow:    32_768 },
    "gpt-4":                       { inputPer1M: 0,    outputPer1M: 0,  contextWindow:     8_192 },
    "gpt-3.5-turbo":               { inputPer1M: 0,    outputPer1M: 0,  contextWindow:    16_385 },
  },

  // ── Google Gemini ──────────────────────────────────────────────────────────
  // Pricing: https://ai.google.dev/gemini-api/docs/pricing
  // Free tier reflected as 0/0 (paid tier env-override expected for billing).
  gemini: {
    "gemini-2.5-pro":              { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gemini-2.5-flash":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gemini-2.5-flash-lite":       { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "gemini-2.0-flash":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_048_576 },
    "gemini-2.0-flash-lite":       { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "gemini-1.5-pro":              { inputPer1M: 0, outputPer1M: 0, contextWindow: 2_097_152 },
    "gemini-1.5-flash":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_048_576 },
    "gemini-1.5-flash-8b":         { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_048_576 },
  },

  // ── GitHub Copilot ─────────────────────────────────────────────────────────
  // Billing rolls into Copilot subscription — list prices reported as 0.
  // Routing: github.ai/inference proxies these models.
  copilot: {


    "gpt-5.4":                     { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_050_000 },
    "gpt-5.4-mini":                { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },


    "gpt-5.4-nano":                { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.4-pro":                 { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_100_000 },
    "gpt-5.3":                     { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.2":                     { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1":                     { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1-codex":               { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1-codex-mini":          { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5.1-codex-max":           { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5":                       { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-5-mini":                  { inputPer1M: 0, outputPer1M: 0, contextWindow:   400_000 },
    "gpt-4.1":                     { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gpt-4.1-mini":                { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gpt-4o":                      { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "gpt-4o-mini":                 { inputPer1M: 0, outputPer1M: 0, contextWindow:   128_000 },
    "claude-opus-4-6":             { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-sonnet-4-6":           { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000, contextWindow1MBeta: 1_000_000 },
    "claude-opus-4-5":             { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000 },
    "claude-sonnet-4-5":           { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000 },
    "claude-haiku-4-5":            { inputPer1M: 0, outputPer1M: 0, contextWindow: 200_000 },
  },

  // ── Azure AI Foundry / Vertex AI ───────────────────────────────────────────
  // Deployment-name routed. Azure OpenAI deployments whose deployment id is a
  // known OpenAI model name inherit the OpenAI model spec through
  // `lookupPricingOptional` below so context-window math does not collapse to
  // the conservative 128K fallback. Custom deployment aliases still require
  // `AVE_PRICING_OVERRIDE` because there is no reliable model identity to
  // infer from the alias alone.
  "azure-foundry": {},
  "vertex-ai": {},
  // Self-hosted OpenAI-compatible endpoints (vLLM/SGLang): no per-token billing.
  // Seed the known Ave deployment with its native context window; unknown
  // custom models fall back to FALLBACK_PRICING.
  "openai-compatible": {
    "Qwen3.6-35B-A3B-NVFP4": { inputPer1M: 0, outputPer1M: 0, contextWindow: 262_144 },
    "Nemotron-3-Nano-30B-A3B-FP8": { inputPer1M: 0, outputPer1M: 0, contextWindow: 131_072 },
  },
};

export const FALLBACK_PRICING: ModelPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  contextWindow: 128_000,
};

/**
 * Resolve a pricing entry by exact match, then prefix-match (longest wins —
 * date-suffixed snapshots resolve to their family entry). Returns
 * `FALLBACK_PRICING` on miss so cost / window math always has *some* value
 * to work with (zero pricing + 128K window — conservative).
 *
 * Does NOT consult env overrides. Use `engine/llm/pricing.ts:getModelPricing()`
 * for the override-aware variant.
 */
export function lookupPricing(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing {
  return lookupPricingOptional(vendor, model, table) ?? FALLBACK_PRICING;
}

/**
 * Strict variant — returns `undefined` on miss instead of `FALLBACK_PRICING`.
 * Use this when the caller needs to distinguish "known model" from
 * "unknown / not in catalog" (e.g., disabling cost-mode toggles in UI when
 * pricing is genuinely unavailable rather than zero-by-fallback).
 *
 * Matching ignores case. A model id reaches this table from a provider
 * catalogue or from what the user typed into a settings row, and neither is
 * obliged to spell the id the way this table happens to spell it — a gateway
 * that serves the same weights under a lower-cased id would otherwise miss
 * every entry and silently inherit the conservative fallback window.
 */
export function lookupPricingOptional(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing | undefined {
  const vendorTable = table[vendor] ?? {};
  const exact = vendorTable[model];
  if (exact) return exact;
  const needle = model.toLowerCase();
  let bestKey: string | undefined;
  for (const key of Object.keys(vendorTable)) {
    const candidate = key.toLowerCase();
    // An exact (case-folded) hit is already the longest possible prefix, so
    // nothing later in the table can beat it.
    if (candidate === needle) return vendorTable[key];
    if (needle.startsWith(candidate) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey !== undefined) return vendorTable[bestKey];

  if (vendor === "azure-foundry") {
    return lookupPricingOptional("openai", model, table);
  }

  return undefined;
}

function hasKnownTokenPricing(
  pricing: Pick<ModelPricing, "inputPer1M" | "outputPer1M"> | undefined,
): pricing is ModelPricing {
  return !!pricing && (pricing.inputPer1M > 0 || pricing.outputPer1M > 0);
}

/**
 * Strict cost-display variant. Zero-price catalog rows may be valid for
 * context-window lookup (unknown direct provider pricing, subscription-billed
 * routes, or free-tier placeholders), but they are not safe to present as
 * "$0" token cost unless a caller has a separate billing contract.
 */
export function lookupBillablePricingOptional(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing | undefined {
  if (vendor === "azure-foundry") {
    const vendorTable = table[vendor] ?? {};
    const exact = vendorTable[model];
    if (hasKnownTokenPricing(exact)) return exact;
    let bestKey: string | undefined;
    for (const key of Object.keys(vendorTable)) {
      if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
        bestKey = key;
      }
    }
    const direct = bestKey !== undefined ? vendorTable[bestKey] : undefined;
    return hasKnownTokenPricing(direct) ? direct : undefined;
  }
  const pricing = lookupPricingOptional(vendor, model, table);
  return hasKnownTokenPricing(pricing) ? pricing : undefined;
}

/**
 * Anthropic prompt cache per-1M rates resolved against an explicit pricing
 * entry. When the entry omits `cacheReadPer1M` / `cacheWritePer1M`, the
 * publicly-documented Anthropic ratios are applied:
 *
 *   - read  = 0.1× input    (Sonnet $3 → $0.30, Opus $15 → $1.50, Haiku $1 → $0.10)
 *   - write = 1.25× input   (5m TTL — same ratio across Sonnet/Opus/Haiku)
 *
 * 1h-TTL deployments (write rate 2× input) require an explicit
 * `cacheWritePer1M` override on the pricing entry. This helper is the single
 * place these ratios are encoded; engine cost math
 * (`engine/llm/pricing.ts:computeCost`) and the renderer billing badge
 * (`TokenCostBadge.tsx`) both consume it so the published ratios stay in
 * sync without duplication.
 */
export function anthropicCacheRates(
  pricing: Pick<TokenRates, "inputPer1M" | "cacheReadPer1M" | "cacheWritePer1M">,
): { read: number; write: number } {
  return {
    read: pricing.cacheReadPer1M ?? pricing.inputPer1M * 0.1,
    write: pricing.cacheWritePer1M ?? pricing.inputPer1M * 1.25,
  };
}

/**
 * Effective context window — picks the beta-tier value when defined.
 *
 * The adapter auto-sends the `context-1m-2025-08-07` header for any Claude
 * model with `contextWindow1MBeta` set, so the larger window is what the
 * model actually delivers. UI denominators and compact thresholds must
 * mirror this resolution to avoid denominator mismatch.
 */
export function effectiveContextWindow(pricing: ModelPricing): number {
  return pricing.contextWindow1MBeta ?? pricing.contextWindow;
}




export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * The part of `outputTokens` the provider reports as reasoning (AI SDK
   * `outputTokenDetails.reasoningTokens`). Priced at `reasoningPer1M` when the
   * rates state one; otherwise it is ordinary output.
   */
  reasoningTokens?: number;
}

/**
 * Normalize AI SDK v6 usage into the provider-cost contract above.
 *
 * AI SDK reports `inputTokens` as total prompt tokens and puts cache details
 * under `inputTokenDetails`. Anthropic cost math needs fresh input plus
 * additive cache lines, while OpenAI/Gemini style providers already include
 * cache inside prompt tokens. Their cached subset is split inside
 * `computeCost`, not at this normalization boundary.
 */
export function normalizeAiSdkUsageForCost<T extends UsageForCost | undefined>(
  usage: T,
  vendor: string,
): T {
  if (!usage || toPricingVendor(vendor) !== "claude") return usage;
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? (usage.cacheReadTokens ?? 0) : 0;
  const cacheWrite = Number.isFinite(usage.cacheWriteTokens) ? (usage.cacheWriteTokens ?? 0) : 0;
  return {
    ...usage,
    inputTokens: Math.max(0, input - Math.max(0, cacheRead) - Math.max(0, cacheWrite)),
  };
}

/**
 * The prompt size a request's price tier is chosen by: every prompt token the
 * provider read, cached or not. Anthropic usage (after
 * {@link normalizeAiSdkUsageForCost}) counts fresh input apart from the cache
 * lines, so they are added back; everyone else reports the cache inside the
 * prompt count already.
 */
export function promptTokensForTier(usage: UsageForCost, vendor: string): number {
  const input = nonNegative(usage.inputTokens);
  if (toPricingVendor(vendor) !== "claude") return input;
  return input + nonNegative(usage.cacheReadTokens) + nonNegative(usage.cacheWriteTokens);
}

/**
 * The rates in force for a request whose prompt is `promptTokens` long: the
 * highest tier the prompt exceeds (strictly — a prompt exactly at the boundary
 * is billed at the rates below it), with any rate the tier does not state kept
 * from the base. No tiers, or a prompt within the first, is the base.
 */
export function ratesForPrompt(rates: TokenRates, promptTokens: number): TokenRates {
  let tier: TokenRateTier | undefined;
  for (const candidate of rates.tiers ?? []) {
    if (promptTokens > candidate.afterInputTokens && (tier === undefined || candidate.afterInputTokens > tier.afterInputTokens)) {
      tier = candidate;
    }
  }
  if (tier === undefined) return rates;
  return {
    ...rates,
    inputPer1M: tier.inputPer1M ?? rates.inputPer1M,
    outputPer1M: tier.outputPer1M ?? rates.outputPer1M,
    ...(tier.cacheReadPer1M !== undefined ? { cacheReadPer1M: tier.cacheReadPer1M } : {}),
    ...(tier.cacheWritePer1M !== undefined ? { cacheWritePer1M: tier.cacheWritePer1M } : {}),
  };
}

function nonNegative(n: number | undefined): number {
  // Token usage is monotonic, so a negative or non-finite value is malformed
  // upstream data; letting it through would produce negative USD and pollute
  // the usage dashboard.
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute cost (USD) for one request's usage against per-1M rates.
 *
 * Vendor argument selects how `inputTokens` and the cache fields combine —
 * see {@link UsageForCost} for the semantic asymmetry between Anthropic
 * (cache-additive) and everyone else (cache-included). The price tier is
 * chosen by the request's whole prompt ({@link promptTokensForTier}), so a
 * caller must price each provider request on its own: a turn's sum of rounds
 * is not one prompt.
 *
 * Lives here (not in `engine/llm/pricing.ts`) so renderer-side billing UI
 * (`TokenCostBadge`) consumes the same formula without pulling Node-only
 * imports. The engine module re-exports for back-compat.
 */
export function computeCost(
  usage: UsageForCost,
  pricing: TokenRates,
  vendor: string,
): number {
  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const reasoning = Math.min(output, nonNegative(usage.reasoningTokens));
  const rates = ratesForPrompt(pricing, promptTokensForTier(usage, vendor));
  const pricedReasoning = rates.reasoningRateScope === "output" && reasoning > 0 ? output : reasoning;

  const per1M = (tokens: number, rate: number): number =>
    (tokens / 1_000_000) * rate;
  const outputCost = (outMul: number): number =>
    per1M(output - pricedReasoning, rates.outputPer1M * outMul)
    + per1M(pricedReasoning, (rates.reasoningPer1M ?? rates.outputPer1M) * outMul);

  if (toPricingVendor(vendor) === "claude") {
    const { read: cacheReadRate, write: cacheWriteRate } = anthropicCacheRates(rates);
    return (
      per1M(input, rates.inputPer1M) +
      per1M(cacheRead, cacheReadRate) +
      per1M(cacheWrite, cacheWriteRate) +
      outputCost(1)
    );
  }
  // The provider's prompt count already includes the cache, so adding the
  // cache lines on top would double-count. Split the prompt into fresh, cache
  // read and cache write instead, so a published cache rate shows in every
  // cost surface; a cache rate the rates do not state is the input rate.
  const inSurcharge =
    typeof rates.surchargeInputThreshold === "number"
    && input > rates.surchargeInputThreshold;
  const inMul = inSurcharge ? (rates.surchargeInputMultiplier ?? 1) : 1;
  const outMul = inSurcharge ? (rates.surchargeOutputMultiplier ?? 1) : 1;
  const cachedRead = Math.min(input, cacheRead);
  const cachedWrite = Math.min(input - cachedRead, cacheWrite);
  const freshInput = input - cachedRead - cachedWrite;
  return (
    per1M(freshInput, rates.inputPer1M * inMul) +
    per1M(cachedRead, (rates.cacheReadPer1M ?? rates.inputPer1M) * inMul) +
    per1M(cachedWrite, (rates.cacheWritePer1M ?? rates.inputPer1M) * inMul) +
    outputCost(outMul)
  );
}
