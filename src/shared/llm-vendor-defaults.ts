/**
 * Single source of truth for the LLM vendor list and per-vendor default
 * configuration block. Consumed by `data/settings-store.ts` (to seed the
 * default-visible LLM vendor blocks) and by the renderer's `VENDORS` constant
 * (for the model dropdown shown in the settings dialog).
 *
 * Pure, browser-safe — no Electron / Node imports.
 */
import { DEFAULT_LLM_OUTPUT_TOKEN_LIMIT } from "./model-host-policy.js";
import { catalogChatModelIds, vendorHasCatalogProvider } from "./model-catalog/vendor-models.js";

export const OPENAI_COMPATIBLE_PRESET_VENDOR_IDS = [
  "openrouter",
  "deepseek",
  "xai",
  "together",
  "fireworks",
  "groq",
  "poolside",
  "cerebras",
  "sambanova",
  "nebius",
  "baseten",
  "requesty",
  "litellm",
  "huggingface",
  "vercel-ai-gateway",
  "vercel-v0",
  "aihubmix",
  "hicap",
  "nous-research",
  "huawei-cloud-maas",
  "wandb",
  "xiaomi",
  "kilo",
  "zai",
  "zai-coding-plan",
  "qwen",
  "qwen-code",
  "doubao",
  "mistral",
  "moonshot",
  "asksage",
  "ollama",
  "lmstudio",
  "oca",
] as const;

export type OpenAICompatiblePresetVendor =
  (typeof OPENAI_COMPATIBLE_PRESET_VENDOR_IDS)[number];

export interface OpenAICompatibleVendorPreset {
  label: string;
  apiKeyPlaceholder: string;
  baseUrl: string;
  /**
   * The provider-native id a newly connected route starts on. Public ids
   * must resolve to a catalog chat entry; an existing account-scoped
   * deployment may remain unclassified.
   */
  defaultModel: string;
  /**
   * Hand-picked choices, only for a vendor no catalog provider describes (a
   * local runtime, a self-hosted gateway, an endpoint the catalog does not
   * list). A vendor with a catalog provider offers what the catalog says it
   * serves ({@link llmVendorModelOptions}) and must not declare this.
   */
  modelOptions?: readonly string[];
  /**
   * The endpoint routes to models other providers serve. Its `/models` answer
   * says what this gateway forwards today, not whether the model's own vendor
   * still serves it, so it never proves a model retired (design
   * `model-capability-catalog.md` §6.1).
   */
  gateway?: true;
}

export const OPENAI_COMPATIBLE_VENDOR_PRESETS: Readonly<
  Record<OpenAICompatiblePresetVendor, OpenAICompatibleVendorPreset>
> = Object.freeze({
  openrouter: {
    label: "OpenRouter",
    apiKeyPlaceholder: "sk-or-...",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.6",
    gateway: true,
  },
  deepseek: {
    label: "DeepSeek",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-flash",
  },
  xai: {
    label: "xAI",
    apiKeyPlaceholder: "xai-...",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.20-0309-non-reasoning",
  },
  together: {
    label: "Together AI",
    apiKeyPlaceholder: "tog_...",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "Qwen/Qwen3.6-Plus",
  },
  fireworks: {
    label: "Fireworks AI",
    apiKeyPlaceholder: "fw_...",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/glm-5p3-flash",
  },
  groq: {
    label: "Groq",
    apiKeyPlaceholder: "gsk_...",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
  },
  poolside: {
    label: "Poolside",
    apiKeyPlaceholder: "ps_...",
    baseUrl: "https://inference.poolside.ai/v1",
    defaultModel: "poolside/laguna-m.1",
  },
  cerebras: {
    label: "Cerebras",
    apiKeyPlaceholder: "csk-...",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "gpt-oss-120b",
  },
  sambanova: {
    label: "SambaNova",
    apiKeyPlaceholder: "sambanova-...",
    baseUrl: "https://api.sambanova.ai/v1",
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    modelOptions: ["Meta-Llama-3.3-70B-Instruct"],
  },
  nebius: {
    label: "Nebius",
    apiKeyPlaceholder: "nebius_...",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
  },
  baseten: {
    label: "Baseten",
    apiKeyPlaceholder: "baseten_...",
    baseUrl: "https://inference.baseten.co/v1",
    defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
  },
  requesty: {
    label: "Requesty",
    apiKeyPlaceholder: "rq_...",
    baseUrl: "https://router.requesty.ai/v1",
    defaultModel: "openai/gpt-6-luna",
    gateway: true,
  },
  litellm: {
    label: "LiteLLM",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "http://localhost:4000/v1",
    defaultModel: "gpt-5.4",
    modelOptions: ["gpt-5.4", "claude-sonnet-4-6"],
    gateway: true,
  },
  huggingface: {
    label: "Hugging Face",
    apiKeyPlaceholder: "hf_...",
    baseUrl: "https://router.huggingface.co/v1",
    defaultModel: "MiniMaxAI/MiniMax-M2.5",
    gateway: true,
  },
  "vercel-ai-gateway": {
    label: "Vercel AI Gateway",
    apiKeyPlaceholder: "vck_...",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    defaultModel: "alibaba/qwen3.6-plus",
    gateway: true,
  },
  "vercel-v0": {
    label: "Vercel V0",
    apiKeyPlaceholder: "v0_...",
    baseUrl: "https://api.v0.dev/v1",
    defaultModel: "v0-1.5-md",
    modelOptions: ["v0-1.5-md"],
  },
  aihubmix: {
    label: "AI Hub Mix",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://api.aihubmix.com/v1",
    defaultModel: "gpt-5.4-mini",
    gateway: true,
  },
  hicap: {
    label: "HiCap",
    apiKeyPlaceholder: "hicap_...",
    baseUrl: "https://api.hicap.ai/v1",
    defaultModel: "hicap-pro",
    modelOptions: ["hicap-pro"],
  },
  "nous-research": {
    label: "Nous Research",
    apiKeyPlaceholder: "nr_...",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    defaultModel: "DeepHermes-3-Llama-3-3-70B-Preview",
    modelOptions: ["DeepHermes-3-Llama-3-3-70B-Preview"],
  },
  "huawei-cloud-maas": {
    label: "Huawei Cloud MaaS",
    apiKeyPlaceholder: "huawei_...",
    baseUrl: "https://infer-modelarts.cn-southwest-2.myhuaweicloud.com/v1",
    defaultModel: "DeepSeek-R1",
    modelOptions: ["DeepSeek-R1"],
  },
  wandb: {
    label: "W&B by CoreWeave",
    apiKeyPlaceholder: "wandb_...",
    baseUrl: "https://api.inference.wandb.ai/v1",
    defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
  },
  xiaomi: {
    label: "Xiaomi",
    apiKeyPlaceholder: "mi_...",
    baseUrl: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.6-flash",
  },
  kilo: {
    label: "Kilo Gateway",
    apiKeyPlaceholder: "kilo_...",
    baseUrl: "https://api.kilo.ai/api/gateway",
    defaultModel: "openai/gpt-5.4",
    gateway: true,
  },
  zai: {
    label: "Z.AI",
    apiKeyPlaceholder: "zhipu_...",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5v-turbo",
  },
  "zai-coding-plan": {
    label: "Z.AI Coding Plan",
    apiKeyPlaceholder: "zhipu_...",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    defaultModel: "glm-5.2",
  },
  qwen: {
    label: "Alibaba Qwen",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.7-plus",
  },
  "qwen-code": {
    label: "Alibaba Qwen Code",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-coder-plus",
  },
  doubao: {
    label: "Doubao",
    apiKeyPlaceholder: "ark_...",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-1-5-pro-256k-250115",
  },
  mistral: {
    label: "Mistral",
    apiKeyPlaceholder: "mistral_...",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-medium-latest",
  },
  moonshot: {
    label: "Moonshot",
    apiKeyPlaceholder: "sk-...",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3",
  },
  asksage: {
    label: "AskSage",
    apiKeyPlaceholder: "asksage_...",
    baseUrl: "https://api.asksage.ai/server",
    defaultModel: "gpt-5.4-mini",
    modelOptions: ["gpt-5.4-mini"],
  },
  ollama: {
    label: "Ollama",
    apiKeyPlaceholder: "ollama",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.3",
    modelOptions: ["llama3.3", "qwen3", "gpt-oss"],
  },
  lmstudio: {
    label: "LM Studio",
    apiKeyPlaceholder: "lm-studio",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    modelOptions: ["local-model"],
  },
  oca: {
    label: "Oracle Code Assist",
    apiKeyPlaceholder: "oca_...",
    baseUrl: "https://code.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm",
    defaultModel: "anthropic/claude-3-7-sonnet-20250219",
    modelOptions: ["anthropic/claude-3-7-sonnet-20250219"],
  },
});

const OPENAI_COMPATIBLE_PRESET_VENDOR_SET = new Set<string>(
  OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
);

export const LLM_VENDORS = [
  "claude",
  "openai",
  "gemini",
  "azure-foundry",
  "vertex-ai",
  "openai-compatible",
  ...OPENAI_COMPATIBLE_PRESET_VENDOR_IDS,
] as const;

export type LLMVendor = (typeof LLM_VENDORS)[number];

/**
 * Vendor ids Ave once shipped and has since removed. They are NOT vendors:
 * `isLLMVendor` rejects them. They are recognized in exactly one place, the
 * settings load, so a profile that still names one is migrated off it with a
 * notice instead of being silently pointed at another vendor.
 */
export const RETIRED_LLM_VENDOR_IDS = ["copilot"] as const;

export type RetiredLLMVendor = (typeof RETIRED_LLM_VENDOR_IDS)[number];

export function isRetiredLLMVendor(v: unknown): v is RetiredLLMVendor {
  return typeof v === "string" && (RETIRED_LLM_VENDOR_IDS as readonly string[]).includes(v);
}

/**
 * The two tiers of a model going away (design `model-capability-catalog.md`
 * §6.1):
 * - `"unlisted"` (retired): the vendor's own complete `/models` listing on
 *   its native host no longer names it. The route is blocked until the user
 *   picks another model.
 * - `"catalog-deprecated"` (deprecated): the active catalog marks it
 *   `deprecated`. It is hidden from the pickers and the user is told, but the
 *   route keeps working.
 */
export type LlmModelRetirementReason = "catalog-deprecated" | "unlisted";

/**
 * The saved active model that the last settings load found retired. Only the
 * retired tier (`"unlisted"`) blocks the route; a deprecated model never
 * carries this marker.
 */
export interface RetiredLlmModel {
  vendor: LLMVendor;
  model: string;
  reason: "unlisted";
}

/**
 * The value of `llm.retiredProvider`: the removed vendor the stored profile
 * named (a string, as #2658 writes it) or the retired model it named (an
 * object). Either leaves the route unresolved until the user picks one.
 */
export type LlmRouteRetirement = RetiredLLMVendor | RetiredLlmModel;

export function isRetiredLlmModelMarker(v: unknown): v is RetiredLlmModel {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const record = v as Partial<Record<keyof RetiredLlmModel, unknown>>;
  return isLLMVendor(record.vendor)
    && typeof record.model === "string" && record.model.trim() !== ""
    && record.reason === "unlisted";
}

export function isLlmRouteRetirement(v: unknown): v is LlmRouteRetirement {
  return isRetiredLLMVendor(v) || isRetiredLlmModelMarker(v);
}

/**
 * Providers shipped as the built-in provider surface. The full `LLM_VENDORS`
 * union intentionally remains broad for settings, secrets, legacy configs,
 * and runtime compatibility while long-tail providers move to marketplace
 * packages.
 */
export const BUILT_IN_LLM_VENDOR_IDS = [
  "openai",
  "claude",
  "gemini",
  "openrouter",
  "openai-compatible",
] as const satisfies readonly LLMVendor[];

export type BuiltInLLMVendor = (typeof BUILT_IN_LLM_VENDOR_IDS)[number];

/**
 * Compatibility alias for existing settings/UI code. New provider-registry
 * code should prefer `BUILT_IN_LLM_VENDOR_IDS` when it means "ships in core".
 */
export const DEFAULT_VISIBLE_LLM_VENDOR_IDS = BUILT_IN_LLM_VENDOR_IDS;

export type DefaultVisibleLLMVendor = BuiltInLLMVendor;

const DEFAULT_VISIBLE_LLM_VENDOR_ID_SET = new Set<string>(
  BUILT_IN_LLM_VENDOR_IDS,
);

export type InstalledLLMVendor = Exclude<LLMVendor, BuiltInLLMVendor>;

/**
 * Seed provider ids that can be made available through marketplace install
 * state. This is not the user's dynamic installed-provider state; settings
 * own that. The static list preserves a typed bridge while catalog ownership
 * moves out of core.
 */
export const INSTALLED_LLM_VENDOR_IDS = LLM_VENDORS.filter(
  (vendor): vendor is InstalledLLMVendor =>
    !DEFAULT_VISIBLE_LLM_VENDOR_ID_SET.has(vendor),
);

/**
 * Provider ids accepted at migration/secret/runtime boundaries even when they
 * are no longer part of the built-in surface. This intentionally mirrors the
 * marketplace seed list until provider package metadata is fully catalog-owned.
 */
export const KNOWN_LEGACY_LLM_VENDOR_IDS = INSTALLED_LLM_VENDOR_IDS;

export type KnownLegacyLLMVendor = (typeof KNOWN_LEGACY_LLM_VENDOR_IDS)[number];

export type MarketplaceEligibleLLMVendor = InstalledLLMVendor;

export const MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS = INSTALLED_LLM_VENDOR_IDS;

const MARKETPLACE_ELIGIBLE_LLM_VENDOR_ID_SET = new Set<string>(
  MARKETPLACE_ELIGIBLE_LLM_VENDOR_IDS,
);

export function isDefaultVisibleLLMVendor(
  vendor: unknown,
): vendor is DefaultVisibleLLMVendor {
  return (
    typeof vendor === "string" &&
    DEFAULT_VISIBLE_LLM_VENDOR_ID_SET.has(vendor)
  );
}

export function isMarketplaceEligibleLLMVendor(
  vendor: unknown,
): vendor is MarketplaceEligibleLLMVendor {
  return (
    typeof vendor === "string" &&
    MARKETPLACE_ELIGIBLE_LLM_VENDOR_ID_SET.has(vendor)
  );
}

/**
 * Canonical fallback vendor — used both as the seed for
 * `DEFAULT_SETTINGS.llm.provider` and as the boundary-narrowing fallback
 * when a corrupt settings.json or IPC payload delivers an out-of-union
 * value. Centralizing here keeps the two in lockstep; flipping the
 * default elsewhere without updating the narrower would otherwise drift
 * silently.
 *
 * Fresh installs stay on the default-visible provider surface so optional
 * marketplace providers are not materialized until selected or installed.
 */
export const DEFAULT_LLM_VENDOR: LLMVendor = "openai";
const DEFAULT_THINKING_BUDGET_TOKENS = 8_000;
const THINKING_BUDGET_PRESETS = [
  { key: "low", budget: 4_000 },
  { key: "medium", budget: 8_000 },
  { key: "high", budget: 16_000 },
  { key: "xhigh", budget: 32_000 },
] as const;

interface LlmThinkingBudgetRung {
  readonly key: (typeof THINKING_BUDGET_PRESETS)[number]["key"];
  readonly budget: number;
}

function normalizeLlmOutputTokenLimit(value: unknown): number {
  return explicitLlmOutputTokenLimit(value) ?? DEFAULT_LLM_OUTPUT_TOKEN_LIMIT;
}

/** A stored output limit the user set: a positive safe integer, else none. */
function explicitLlmOutputTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Who chose a route's requested output limit. */
export type LlmOutputTokenLimitSource = "user" | "host-default";

/**
 * The output limit a vendor block requests, and who chose it. The block
 * carries `outputTokenLimit` only when the user set one; absence is the host
 * default, reported as such rather than written into the block, so the
 * default can change without every saved block holding the old number.
 */
export function requestedLlmOutputTokenLimit(
  block: Pick<LLMVendorSettings, "outputTokenLimit">,
): { value: number; source: LlmOutputTokenLimitSource } {
  const explicit = explicitLlmOutputTokenLimit(block.outputTokenLimit);
  return explicit === undefined
    ? { value: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT, source: "host-default" }
    : { value: explicit, source: "user" };
}

/** User budget cap: the highest preset strictly below output, or output minus one. */
export function getLlmThinkingBudgetLimit(outputTokenLimit?: number): number {
  const output = normalizeLlmOutputTokenLimit(outputTokenLimit);
  return getLlmThinkingBudgetRungs(output).at(-1)?.budget ?? Math.max(0, output - 1);
}

/** Normalize user input without changing raw internal generation parameters. */
export function normalizeLlmThinkingBudgetTokens(value: unknown, outputTokenLimit?: number): number {
  const budget = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_THINKING_BUDGET_TOKENS;
  return Math.min(budget, getLlmThinkingBudgetLimit(outputTokenLimit));
}

/**
 * Fixed user presets, filtered by the output ceiling. The default 32k output
 * exposes low/medium/high at 4k/8k/16k; xhigh requires output above 32k.
 * Reading a valid custom budget does not snap it to one of these presets.
 */
export function getLlmThinkingBudgetRungs(outputTokenLimit?: number): readonly LlmThinkingBudgetRung[] {
  const output = normalizeLlmOutputTokenLimit(outputTokenLimit);
  return THINKING_BUDGET_PRESETS.filter((preset) => preset.budget < output);
}

/**
 * Runtime type guard — narrows `unknown` to `LLMVendor`. Use at every
 * boundary that accepts vendor strings from outside the type system:
 * settings.json on disk, IPC payloads, query params, deep-linked URLs,
 * etc. Internal code that already has a `LLMVendor` typed value should
 * NOT need this — the type system carries the proof.
 *
 * Empty / non-string / unknown-string inputs return false. The set is
 * the same `LLM_VENDORS` constant used by settings, secrets, provider
 * factories, and marketplace package metadata. A `true` result proves the id
 * is known; settings code must still tolerate missing `vendors[v]` entries
 * because long-tail provider blocks are now materialized lazily.
 */
export function isLLMVendor(v: unknown): v is LLMVendor {
  return (
    typeof v === "string" &&
    (LLM_VENDORS as readonly string[]).includes(v)
  );
}

/**
 * {@link isLLMVendor} as a narrower: the vendor if it is known, otherwise
 * {@link DEFAULT_LLM_VENDOR}. For the renderer's settings/IPC boundaries,
 * where an unknown vendor string must not leave a control without a vendor.
 */
export function narrowLlmVendor(raw: unknown): LLMVendor {
  return isLLMVendor(raw) ? raw : DEFAULT_LLM_VENDOR;
}

export function isOpenAICompatiblePresetVendor(
  v: unknown,
): v is OpenAICompatiblePresetVendor {
  return typeof v === "string" && OPENAI_COMPATIBLE_PRESET_VENDOR_SET.has(v);
}

export function isOpenAICompatibleVendor(v: LLMVendor): boolean {
  return v === "openai-compatible" || isOpenAICompatiblePresetVendor(v);
}

const API_KEY_OPTIONAL_LLM_VENDOR_IDS = new Set<LLMVendor>([
  "openai-compatible",
  "litellm",
  "ollama",
  "lmstudio",
]);

export function isApiKeyOptionalLlmVendor(v: LLMVendor): boolean {
  return API_KEY_OPTIONAL_LLM_VENDOR_IDS.has(v);
}

/**
 * Self-hosted vLLM / llama.cpp / Ollama / LM Studio class — the OpenAI-compatible
 * endpoints that actually honor vLLM's nonstandard request extensions:
 *   - `chat_template_kwargs.enable_thinking` (per-request reasoning toggle), and
 *   - `continue_final_message` (zero-seam finish_reason=length continuation).
 *
 * DELIBERATELY narrower than {@link isOpenAICompatibleVendor}: the commercial
 * OpenAI-compatible gateways (openrouter / groq / together / fireworks /
 * deepseek / mistral / xai / …) reject or silently ignore these top-level
 * fields, so forwarding `chat_template_kwargs` to them 400/422s or no-ops. Only
 * the self-hosted class below runs a chat template that reads them, so it is the
 * single SOT for BOTH the adapter's `chat_template_kwargs` guard and the
 * length-continuation capability (`vendorSupportsLengthContinuation`).
 *
 * This intentionally mirrors {@link API_KEY_OPTIONAL_LLM_VENDOR_IDS} today but is
 * a distinct concept (vLLM extension support, not credential-optionality) and
 * must stay independently editable — a future keyless commercial gateway would
 * belong in one set but not the other.
 */
const SELF_HOSTED_VLLM_VENDOR_IDS = new Set<LLMVendor>([
  "openai-compatible",
  "litellm",
  "ollama",
  "lmstudio",
]);

export function isSelfHostedVllmVendor(v: LLMVendor): boolean {
  return SELF_HOSTED_VLLM_VENDOR_IDS.has(v);
}

/**
 * Network-trust class — the saved self-hosted OpenAI-compatible endpoints a user
 * may point at a private/loopback address and, for that exact configured origin,
 * carry credentials over insecure (plain-HTTP) transport.
 *
 * This is the single SOT for NETWORK TRUST: private/loopback network access plus
 * insecure-credentialed HTTP for a *saved* self-hosted endpoint. It gates the
 * `createGuardedModelProviderFetch` runtime-fetch selection (provider.ts,
 * reviewer-permission-wiring.ts) and the saved-self-hosted model-list sync
 * (model-list.ts).
 *
 * DELIBERATELY DISTINCT from {@link isSelfHostedVllmVendor}, which is
 * request-shaping (chat_template_kwargs / continue_final_message length
 * continuation). The two sets mirror each other TODAY but must stay
 * independently editable — a future keyless commercial gateway could be trusted
 * on the network without running a vLLM chat template, so it would belong in one
 * set but not the other. Editing one must never silently move the other.
 */
const SELF_HOSTED_TRUSTED_NETWORK_VENDOR_IDS = new Set<LLMVendor>([
  "openai-compatible",
  "litellm",
  "ollama",
  "lmstudio",
]);

export function isSelfHostedTrustedNetworkVendor(v: LLMVendor): boolean {
  return SELF_HOSTED_TRUSTED_NETWORK_VENDOR_IDS.has(v);
}

/**
 * Every endpoint an LLM route could reach, as stored.
 *
 * A marketplace provider preset's address lives in the preset registry, not in
 * `vendors["openai-compatible"]` — that block belongs to the generic custom
 * provider row. So walking the vendor blocks alone no longer sees the address
 * chat is actually talking to, and a caller that did would drop the active
 * preset's host on the floor.
 *
 * Both the sandbox's network union and the change-detection signature that
 * refreshes it read this, so the two can never disagree about which hosts are
 * in play. Only the ACTIVE preset is included: an installed-but-unselected
 * preset is not a route anything reaches, and adding it would widen an
 * enforced allow-list for a provider nobody chose.
 *
 * Structural parameters rather than `AppSettings`: the callers hand this
 * partial and normalized shapes, and one of them lives in the sandbox module
 * that deliberately keeps itself free of settings imports.
 */
export function llmRouteBaseUrls(input: {
  readonly vendors?: Readonly<Record<string, { readonly baseUrl?: string } | undefined>> | undefined;
  readonly marketplaceProviderPresetId?: string | undefined;
  readonly installedProviderPresets?:
    | readonly { readonly providerId: string; readonly baseUrl?: string }[]
    | undefined;
}): string[] {
  const seen = new Set<string>();
  const baseUrls: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    baseUrls.push(trimmed);
  };
  for (const block of Object.values(input.vendors ?? {})) push(block?.baseUrl);
  const activePresetId = input.marketplaceProviderPresetId?.trim();
  if (activePresetId) {
    const preset = (input.installedProviderPresets ?? [])
      .find((candidate) => candidate.providerId === activePresetId);
    push(preset?.baseUrl);
  }
  return baseUrls;
}

/**
 * Stable signature of every endpoint an LLM route could reach: each vendor
 * block's configured `baseUrl` plus the active marketplace provider preset's
 * address, which lives in the preset registry rather than in a vendor block.
 * The settings and chat IPC domains both read this one helper so they cannot
 * disagree about which endpoints count.
 *
 * Change-detection for the ASRT sandbox network union: the union is rebuilt
 * only when this moves. It is keyed by the SET of endpoints rather than by
 * vendor id, because the union is a set of hosts — the same address moving
 * between two vendor blocks does not change what a worker may reach, and a
 * refresh for it would be noise. Sorted so vendor-key insertion order cannot
 * fake a change.
 */
export function llmRouteBaseUrlSignature(
  llm: Pick<Parameters<typeof llmRouteBaseUrls>[0], "vendors" | "marketplaceProviderPresetId">,
  installedProviderPresets: Parameters<typeof llmRouteBaseUrls>[0]["installedProviderPresets"],
): string {
  return [...llmRouteBaseUrls({
    vendors: llm.vendors,
    marketplaceProviderPresetId: llm.marketplaceProviderPresetId,
    installedProviderPresets,
  })].sort().join("|");
}

export function canUseLlmVendorWithoutApiKey(
  vendor: LLMVendor,
  block: Pick<LLMVendorSettings, "baseUrl">,
): boolean {
  return isApiKeyOptionalLlmVendor(vendor) && Boolean(block.baseUrl?.trim());
}

/**
 * Per-vendor configuration block. Every vendor's block in `LLMSettings.vendors`
 * carries its own complete copy of these fields, so switching the active
 * vendor never inherits stale values from the previous one.
 *
 * Optional fields are vendor-specific: `baseUrl` is required for
 * `azure-foundry` and OpenAI-compatible endpoints; `vertexProject` /
 * `vertexLocation` only meaningful for `vertex-ai`.
 *
 * CHANGELOG (CTRL simplification):
 *   Removed `temperature`, `maxOutputTokens`, `seed`, `responseFormat`,
 *   `stopSequences` — modern frontier models (GPT-5+, Claude 4+) deprecate
 *   or ignore these sampling/decoding params. Vendor SDK defaults are used.
 *   Persisted values for these keys are silently dropped on next write.
 *
 */
export interface LLMVendorSettings {
  model: string;
  /**
   * The user's per-request total output limit for API-backed chat. Present
   * only when the user set it (a positive integer); absent means the host
   * default, which {@link requestedLlmOutputTokenLimit} supplies and reports
   * as `host-default`. This bounds a round's generation, including reasoning
   * where the provider counts it as output; the effective limit is this,
   * clamped to the model's output ceiling. Smaller internal generation limits
   * belong to their callers. Managed subscription runtimes retain their own
   * output control contract.
   */
  outputTokenLimit?: number;
  /**
   * Set beside `outputTokenLimit` when a user wrote it through this build's
   * settings path. Builds before #2501 wrote the 32,000 default into every
   * saved block and keep doing so after a downgrade; a 32,000 without this
   * stamp is that default, not a choice, and is dropped on load
   * (`src/data/settings-store.ts`).
   */
  outputTokenLimitSetByUser?: true;
  /**
   * The prompt capacity of the model this vendor route serves, declared by the
   * user. Unset by default, and it outranks every other answer: the pricing
   * catalog cannot know a self-hosted or gateway-served model, and a provider
   * that reports nothing about its own limits leaves the host budgeting
   * compaction against the conservative 128K fallback — far too early for a
   * 229K-window deployment, and far too late for a 32K one.
   *
   * Deliberately not on the settings page. The provider's own `/models`
   * handshake answers this for every endpoint that reports it, so a field
   * would ask the user for a number the host can already obtain and would
   * invite a wrong one. It stays an escape hatch for an endpoint that reports
   * nothing, edited in `settings.json`.
   */
  contextWindow?: number;
  /**
   * The model catalog entry this route's model is, as `<provider>/<id>`
   * (`docs/design/model-capability-catalog.md`). Unset by default. A
   * self-hosted or local endpoint is never matched to a public catalog entry
   * by its name, since the name says nothing about what the endpoint runs;
   * setting this says it, and the entry's limits then answer where the
   * endpoint reports none. Applies to the vendor block's own model, not to a
   * marketplace preset reached through the same vendor. An escape hatch
   * edited in `settings.json`, like {@link contextWindow}.
   */
  catalogModel?: string;
  /** Image support declared for a model on this provider or preset route. */
  imageInput?: Partial<Record<string, boolean>>;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
  /**
   * The model each marketplace provider preset runs on, keyed by preset id.
   *
   * A preset is a provider in its own right that is merely REACHED through the
   * `openai-compatible` vendor, so it cannot share this block's single `model`
   * slot with the generic custom-provider row, nor with another preset: the row
   * picked last would silently overwrite every other row's model. Only the
   * `openai-compatible` block carries this — it is the only vendor presets are
   * reached through. Read it through {@link llmRouteModel}, never directly.
   */
  presetModels?: Record<string, string>;
  enableThinking: boolean;
  /** Per API call, bounded by the settings resolver; not a cumulative turn quota. */
  thinkingBudgetTokens: number;
}

export type LLMVendorSettingsMap = Partial<
  Record<LLMVendor, LLMVendorSettings>
>;

const CORE_DEFAULT_MODEL = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
  // New routes start on a currently listed general-purpose chat model.
  gemini: "gemini-3.8-flash",
  "azure-foundry": "gpt-5.4-mini",
  // The catalog marks Vertex's Gemini 2.5 models deprecated (design
  // `model-capability-catalog.md` §6.1), so they are not offered there.
  "vertex-ai": "gemini-3.5-flash",
  // Handshake-only: no static default. A fresh openai-compatible block ships
  // with an EMPTY model so the runtime treats it as "not configured" until the
  // user selects a model fetched live from their endpoint's /models handshake
  // (LlmTab `modelOptionsFor` + `buildProvider` not-configured guard). Shipping
  // a concrete id here previously sent an Ave-cluster model id to arbitrary
  // endpoints that don't serve it, failing every first call with a 400/404.
  "openai-compatible": "",
} as const;

const DEFAULT_MODEL: Record<LLMVendor, string> = Object.freeze({
  ...CORE_DEFAULT_MODEL,
  ...Object.fromEntries(
    OPENAI_COMPATIBLE_PRESET_VENDOR_IDS.map((vendor) => [
      vendor,
      OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].defaultModel,
    ]),
  ),
} as Record<LLMVendor, string>);

/**
 * The model choices a vendor offers before any live `/models` answer.
 *
 * A vendor with a catalog provider offers the chat models the active catalog
 * lists for it (`catalogChatModelIds`), newest first. Every core vendor has
 * one except `openai-compatible`: a self-hosted endpoint (vLLM, SGLang,
 * llama.cpp, a LiteLLM gateway) whose models only its own `/models` handshake
 * can name, so it offers nothing until that answer arrives — a seed here once
 * pre-selected a fabricated id for arbitrary endpoints. A preset vendor with
 * no catalog provider offers its hand-picked `modelOptions`.
 *
 * Read at call time, never at module load: the catalog is installed per
 * process (`model-catalog/active.ts`), and a copy frozen at import would
 * predate it.
 */
export function llmVendorModelOptions(vendor: LLMVendor): readonly string[] {
  if (vendorHasCatalogProvider(vendor)) return catalogChatModelIds(vendor);
  if (vendor === "openai-compatible") return [];
  if (!isOpenAICompatiblePresetVendor(vendor)) {
    throw new Error(`LLM vendor ${vendor} has no catalog provider and no hand-picked model options`);
  }
  const handPicked = OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].modelOptions;
  if (!handPicked) {
    throw new Error(`LLM preset ${vendor} has no catalog provider and declares no modelOptions`);
  }
  return handPicked;
}

/**
 * True when `model` is a model the active `vendor` can serve: one
 * {@link llmVendorModelOptions} offers, or one the vendor's own `/models`
 * answer named (`liveModels`, the model-list cache for the endpoint the route
 * reaches). Used by `SubAgentRunner.resolveSubAgentModel` to validate an agent
 * profile's explicit `model:` frontmatter before applying it as a child
 * `modelOverride`, so an unavailable ID falls back to the parent model
 * instead of hard-failing the sub-agent on a non-retryable provider
 * model-not-found.
 */
export function isModelAvailableForVendor(
  vendor: string,
  model: string,
  liveModels: readonly string[],
): boolean {
  if (!isLLMVendor(vendor)) return false;
  return liveModels.includes(model) || llmVendorModelOptions(vendor).includes(model);
}

function defaultBlock(vendor: LLMVendor): LLMVendorSettings {
  const model = DEFAULT_MODEL[vendor];
  const preset = isOpenAICompatiblePresetVendor(vendor)
    ? OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor]
    : null;
  return {
    model,
    ...(preset ? { baseUrl: preset.baseUrl } : {}),
    enableThinking: true,
    thinkingBudgetTokens: DEFAULT_THINKING_BUDGET_TOKENS,
  };
}

export const LLM_VENDOR_DEFAULTS: Readonly<Record<LLMVendor, LLMVendorSettings>> =
  Object.freeze(
    Object.fromEntries(LLM_VENDORS.map((v) => [v, defaultBlock(v)])) as Record<
      LLMVendor,
      LLMVendorSettings
    >,
  );

/** Longest preset id / model id accepted into a persisted `presetModels` map. */
const MAX_PRESET_MODEL_ENTRY_LENGTH = 256;

/**
 * The per-preset model map, or undefined when it holds nothing usable.
 *
 * Undefined rather than `{}` on purpose: an empty map has to be
 * indistinguishable from an absent one, or a block carrying only an empty map
 * would read as user-customized and survive pruning forever.
 */
function normalizeLlmPresetModels(
  vendor: LLMVendor,
  value: unknown,
): Record<string, string> | undefined {
  // Presets are reached through this vendor and no other, so a map on any
  // other block is stale data, not configuration.
  if (vendor !== "openai-compatible") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const models: Record<string, string> = {};
  for (const [presetId, model] of Object.entries(value as Record<string, unknown>)) {
    if (typeof model !== "string") continue;
    const id = presetId.trim();
    const modelId = model.trim();
    if (!id || !modelId) continue;
    if (id.length > MAX_PRESET_MODEL_ENTRY_LENGTH) continue;
    if (modelId.length > MAX_PRESET_MODEL_ENTRY_LENGTH) continue;
    models[id] = modelId;
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

/**
 * A declared context window, or undefined when nothing usable was stored.
 *
 * A malformed or non-positive value has to read as "not declared" rather than
 * as a tiny window: a stored `0` that survived would zero the preflight
 * threshold and silently switch auto-compaction off for that route.
 */
/** `<provider>/<id>`, both parts non-empty, no whitespace; anything else is treated as unset. */
function normalizeLlmCatalogModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 300 || !/^[^/\s]+\/\S+$/u.test(trimmed)) return undefined;
  return trimmed;
}

/** A model declaration on one route must not configure another preset's model. */
export function llmImageInputKey(model: string, presetId?: string): string {
  return JSON.stringify([presetId?.trim() ?? "", model.trim()]);
}

function normalizeLlmImageInput(value: unknown): LLMVendorSettings["imageInput"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([key, supported]) => {
    if (typeof supported !== "boolean") return false;
    try {
      const scope: unknown = JSON.parse(key);
      return Array.isArray(scope) && scope.length === 2
        && scope.every((part) => typeof part === "string" && part.length <= MAX_PRESET_MODEL_ENTRY_LENGTH)
        && scope[1].trim().length > 0 && key === llmImageInputKey(scope[1], scope[0]);
    } catch {
      return false;
    }
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function llmRouteImageInput(
  block: Pick<LLMVendorSettings, "imageInput">,
  model: string,
  presetId?: string,
): boolean | undefined {
  const key = llmImageInputKey(model, presetId);
  const map = block.imageInput;
  const value = map && Object.hasOwn(map, key) ? map[key] : undefined;
  return typeof value === "boolean" ? value : undefined;
}

function normalizeLlmContextWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

export function getLlmVendorSettings(
  vendors: LLMVendorSettingsMap | undefined,
  vendor: LLMVendor,
): LLMVendorSettings {
  const defaults = LLM_VENDOR_DEFAULTS[vendor];
  const stored = vendors?.[vendor];
  const model =
    typeof stored?.model === "string" ? stored.model : defaults.model;
  const presetModels = normalizeLlmPresetModels(vendor, stored?.presetModels);
  // A hand-edited `0`, fraction or negative would otherwise ride the `...stored`
  // spread all the way to the transport, which reads any non-positive value as
  // "no cap" — the setting would look applied and do nothing.
  const outputTokenLimit = explicitLlmOutputTokenLimit(stored?.outputTokenLimit);
  const contextWindow = normalizeLlmContextWindow(stored?.contextWindow);
  const catalogModel = normalizeLlmCatalogModel(stored?.catalogModel);
  const imageInput = normalizeLlmImageInput(stored?.imageInput);
  const block: LLMVendorSettings = {
    ...defaults,
    ...stored,
    model,
    enableThinking:
      typeof stored?.enableThinking === "boolean"
        ? stored.enableThinking
        : defaults.enableThinking,
    thinkingBudgetTokens: normalizeLlmThinkingBudgetTokens(stored?.thinkingBudgetTokens, outputTokenLimit),
  };
  if (presetModels) block.presetModels = presetModels;
  else delete block.presetModels;
  if (outputTokenLimit !== undefined) block.outputTokenLimit = outputTokenLimit;
  else delete block.outputTokenLimit;
  if (outputTokenLimit !== undefined && stored?.outputTokenLimitSetByUser === true) block.outputTokenLimitSetByUser = true;
  else delete block.outputTokenLimitSetByUser;
  if (contextWindow !== undefined) block.contextWindow = contextWindow;
  else delete block.contextWindow;
  if (catalogModel !== undefined) block.catalogModel = catalogModel;
  else delete block.catalogModel;
  if (imageInput !== undefined) block.imageInput = imageInput;
  else delete block.imageInput;
  return block;
}

/**
 * The model one route runs on: a marketplace preset's own, or the vendor
 * block's when the route is the vendor itself.
 *
 * The single reader of {@link LLMVendorSettings.presetModels}. Everything that
 * asks "what model is this route on" has to come through here, or the answer
 * differs by caller — which is exactly how the generic custom-provider row and
 * every preset ended up overwriting one another's model.
 */
export function llmRouteModel(
  block: Pick<LLMVendorSettings, "model" | "presetModels">,
  marketplaceProviderPresetId?: string,
): string {
  const presetId = marketplaceProviderPresetId?.trim();
  if (!presetId) return block.model;
  return block.presetModels?.[presetId] ?? "";
}

/**
 * That same question asked of the settings as a whole.
 *
 * `provider` is a known vendor by the time settings reach anyone: the store
 * coerces an unrecognized name at the file boundary (`pruneLazyLlmVendorBlocks`),
 * so every caller reading through `SettingsService` is handed one of these.
 */
export function activeLlmRouteModel(llm: {
  provider: LLMVendor;
  vendors: LLMVendorSettingsMap;
  marketplaceProviderPresetId?: string;
}, modelOverride?: string): string {
  return (modelOverride ?? llmRouteModel(
    getLlmVendorSettings(llm.vendors, llm.provider),
    llm.provider === "openai-compatible" ? llm.marketplaceProviderPresetId : undefined,
  )).trim();
}


export function freshVendorBlocks(
  vendorIds: readonly LLMVendor[] = DEFAULT_VISIBLE_LLM_VENDOR_IDS,
): LLMVendorSettingsMap {
  return Object.fromEntries(
    vendorIds.map((v) => [v, getLlmVendorSettings(undefined, v)]),
  ) as LLMVendorSettingsMap;
}

export function freshAllVendorBlocks(): Record<LLMVendor, LLMVendorSettings> {
  return Object.fromEntries(
    LLM_VENDORS.map((v) => [v, getLlmVendorSettings(undefined, v)]),
  ) as Record<LLMVendor, LLMVendorSettings>;
}
