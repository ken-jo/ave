/** Browser-safe vendor and default configuration shared by settings and provider selection. */
import { REASONING_EFFORT_RUNGS } from "./reasoning-effort.js";
import { customProviderWire, type CustomProviderWire } from "./custom-provider.js";
import { DEFAULT_LLM_OUTPUT_TOKEN_LIMIT } from "./model-host-policy.js";
import { catalogChatModelIds, vendorHasCatalogProvider } from "./model-catalog/vendor-models.js";
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from "./safe-integer.js";

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
  /** Recommended metadata does not select a new route’s model; users choose from its catalog or listing. */
  defaultModel: string;
  /** Static choices belong only to providers with no catalog mapping. */
  modelOptions?: readonly string[];
  /** Gateway listings describe routing, never the upstream vendor’s model retirement. */
  gateway?: true;
  /** Model ids are `<upstream>/<model>`. */
  upstreamPrefixedModelIds?: true;
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
    upstreamPrefixedModelIds: true,
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
    upstreamPrefixedModelIds: true,
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
    upstreamPrefixedModelIds: true,
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
    upstreamPrefixedModelIds: true,
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

/** Recognize removed provider ids only during settings migration; never silently select another provider. */
export const RETIRED_LLM_VENDOR_IDS = ["copilot"] as const;

export type RetiredLLMVendor = (typeof RETIRED_LLM_VENDOR_IDS)[number];

export function isRetiredLLMVendor(v: unknown): v is RetiredLLMVendor {
  return typeof v === "string" && (RETIRED_LLM_VENDOR_IDS as readonly string[]).includes(v);
}

/** Unlisted models block the route; catalog-deprecated models remain usable but leave pickers. */
export type LlmModelRetirementReason = "catalog-deprecated" | "unlisted";

/** Only unlisted retirement blocks a saved route; deprecation does not set this marker. */
export interface RetiredLlmModel {
  vendor: LLMVendor;
  model: string;
  reason: "unlisted";
}

/** Removed providers and retired models leave the route unresolved until the user chooses again. */
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

/** Keep compatibility ids broader than the built-in surface for settings, secrets, and lazy provider blocks. */
export const BUILT_IN_LLM_VENDOR_IDS = [
  "openai",
  "claude",
  "gemini",
  "openrouter",
  "openai-compatible",
] as const satisfies readonly LLMVendor[];

type BuiltInLLMVendor = (typeof BUILT_IN_LLM_VENDOR_IDS)[number];

export const DEFAULT_VISIBLE_LLM_VENDOR_IDS = BUILT_IN_LLM_VENDOR_IDS;

export type DefaultVisibleLLMVendor = BuiltInLLMVendor;

const DEFAULT_VISIBLE_LLM_VENDOR_ID_SET = new Set<string>(
  BUILT_IN_LLM_VENDOR_IDS,
);

export type InstalledLLMVendor = Exclude<LLMVendor, BuiltInLLMVendor>;

/** This static seed is not the user’s dynamic installed-provider state. */
export const INSTALLED_LLM_VENDOR_IDS = LLM_VENDORS.filter(
  (vendor): vendor is InstalledLLMVendor =>
    !DEFAULT_VISIBLE_LLM_VENDOR_ID_SET.has(vendor),
);

/** Accept compatibility ids at migration, secret, and runtime boundaries. */
export const KNOWN_LEGACY_LLM_VENDOR_IDS = INSTALLED_LLM_VENDOR_IDS;

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

/** Share the fresh-install default and invalid-value narrowing default; optional providers stay lazy. */
export const DEFAULT_LLM_VENDOR: LLMVendor = "openai";
const DEFAULT_THINKING_BUDGET_TOKENS = 8_000;

interface LlmThinkingBudgetRung {
  readonly key: (typeof REASONING_EFFORT_RUNGS)[number]["key"];
  readonly budget: number;
}

function normalizeLlmOutputTokenLimit(value: unknown): number {
  return explicitLlmOutputTokenLimit(value) ?? DEFAULT_LLM_OUTPUT_TOKEN_LIMIT;
}

/** A stored output limit the user set: a positive safe integer, else none. */
function explicitLlmOutputTokenLimit(value: unknown): number | undefined {
  return isPositiveSafeInteger(value) ? value : undefined;
}

export type LlmOutputTokenLimitSource = "user" | "host-default";

/** Persist only user-selected output limits; absence uses a reported host default that may evolve. */
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
  return getLlmThinkingBudgetRungs(output, true).at(-1)?.budget ?? Math.max(0, output - 1);
}

/** Normalize user input without changing raw internal generation parameters. */
export function normalizeLlmThinkingBudgetTokens(value: unknown, outputTokenLimit?: number): number {
  return Math.min(requestedLlmThinkingBudgetTokens(value), getLlmThinkingBudgetLimit(outputTokenLimit));
}

/** Preserve persisted intent; only numeric request controls are bounded by output. */
export function requestedLlmThinkingBudgetTokens(value: unknown): number {
  return isNonNegativeSafeInteger(value) ? value : DEFAULT_THINKING_BUDGET_TOKENS;
}

/** Presets stay below the output ceiling; valid custom budgets are not snapped to them. */
export function getLlmThinkingBudgetRungs(outputTokenLimit?: number, acceptsMax = false): readonly LlmThinkingBudgetRung[] {
  const output = normalizeLlmOutputTokenLimit(outputTokenLimit);
  return REASONING_EFFORT_RUNGS.filter((preset) => preset.budget < output && (preset.key !== "max" || acceptsMax));
}

/** Known ids may still lack a settings block because provider configuration is materialized lazily. */
export function isLLMVendor(v: unknown): v is LLMVendor {
  return (
    typeof v === "string" &&
    (LLM_VENDORS as readonly string[]).includes(v)
  );
}

/** Unknown boundary values resolve to the default vendor so controls retain a selection. */
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

/** Only declared local template runtimes accept nonstandard reasoning and continuation extensions. */
const SELF_HOSTED_VLLM_VENDOR_IDS = new Set<LLMVendor>([
  "openai-compatible",
  "litellm",
  "ollama",
  "lmstudio",
]);

export function isSelfHostedVllmVendor(v: LLMVendor): boolean {
  return SELF_HOSTED_VLLM_VENDOR_IDS.has(v);
}

/** Network trust applies only to exact saved endpoint origins and remains independent of request-extension support. */
const SELF_HOSTED_TRUSTED_NETWORK_VENDOR_IDS = new Set<LLMVendor>([
  "openai-compatible",
  "litellm",
  "ollama",
  "lmstudio",
]);

export function isSelfHostedTrustedNetworkVendor(v: LLMVendor): boolean {
  return SELF_HOSTED_TRUSTED_NETWORK_VENDOR_IDS.has(v);
}

/** Include vendor endpoints and only the active preset so confinement does not admit unselected hosts. */
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

/** Compare sorted endpoint sets, not vendor identities, when deciding to rebuild the confinement network union. */
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

/** Each vendor owns its configuration; switching providers must not inherit stale values. */
export interface LLMVendorSettings {
  model: string;
  /** User output limits bound one API generation, including counted reasoning, and are clamped to model ceilings. */
  outputTokenLimit?: number;
  /** A user-write stamp distinguishes explicit limits from legacy seeded defaults that normalization drops. */
  outputTokenLimitSetByUser?: true;
  /** Explicit window declarations outrank reports and catalog limits for endpoints that cannot describe themselves. */
  contextWindow?: number;
  /** Explicit catalog identity applies only to the block’s model; custom endpoint names prove no public model identity. */
  catalogModel?: string;
  imageInput?: Partial<Record<string, boolean>>;
  baseUrl?: string;
  wire?: CustomProviderWire;
  vertexProject?: string;
  vertexLocation?: string;
  /** Preset models need separate slots; only the compatible-provider block carries them. Read through llmRouteModel. */
  presetModels?: Record<string, string>;
  enableThinking: boolean;
  /** Per API call, bounded by the settings resolver; not a cumulative turn quota. */
  thinkingBudgetTokens: number;
}

export type LLMVendorSettingsMap = Partial<
  Record<LLMVendor, LLMVendorSettings>
>;

/** Resolve model options at call time after catalog installation; handshake-only endpoints have no fabricated seed model. */
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

/** Accept child models only from catalog or live route listings; otherwise inherit the parent model. */
export function isModelAvailableForVendor(
  vendor: string,
  model: string,
  liveModels: readonly string[],
): boolean {
  if (!isLLMVendor(vendor)) return false;
  return liveModels.includes(model) || llmVendorModelOptions(vendor).includes(model);
}

function defaultBlock(vendor: LLMVendor): LLMVendorSettings {
  const preset = isOpenAICompatiblePresetVendor(vendor)
    ? OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor]
    : null;
  return {
    // A catalog or endpoint listing offers choices; connecting is not a choice.
    model: "",
    ...(preset ? { baseUrl: preset.baseUrl } : {}),
    ...(vendor === "openai-compatible" ? { wire: "openai-chat" as const } : {}),
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

const MAX_PRESET_MODEL_ENTRY_LENGTH = 256;

/** Normalize empty preset maps to absent so inert data cannot keep lazy blocks customized forever. */
function normalizeLlmPresetModels(
  vendor: LLMVendor,
  value: unknown,
): Record<string, string> | undefined {
  // Preset maps on other vendors are stale and must not survive.
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

/** Invalid or zero windows mean undeclared; retaining zero disables compaction. */
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
  return isPositiveSafeInteger(value) ? value : undefined;
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
  // Reject invalid limits before transport can interpret them as no cap.
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
    thinkingBudgetTokens: requestedLlmThinkingBudgetTokens(stored?.thinkingBudgetTokens),
  };
  if (vendor === "openai-compatible") block.wire = customProviderWire(stored?.wire);
  else delete block.wire;
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

/** Read every route through this helper so preset and generic model slots cannot overwrite each other. */
export function llmRouteModel(
  block: Pick<LLMVendorSettings, "model" | "presetModels">,
  marketplaceProviderPresetId?: string,
): string {
  const presetId = marketplaceProviderPresetId?.trim();
  if (!presetId) return block.model;
  return block.presetModels?.[presetId] ?? "";
}

/** Settings normalize provider ids at load; service consumers receive a known vendor. */
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
