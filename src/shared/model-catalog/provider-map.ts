/**
 * Which catalog providers describe the models an Ave vendor serves.
 *
 * The one place an Ave vendor id meets a catalog provider id. The generator
 * reads it to decide what the bundled snapshot keeps; the resolver reads it to
 * look a model up. A vendor is mapped to the catalog providers whose API
 * host is the vendor's own endpoint. A vendor mapped to `[]` serves models no
 * public catalog provider describes at that endpoint — the generic custom
 * endpoint, local runtimes, and gateways the catalog does not list — so its
 * limits come from what the endpoint reports and what the user configures,
 * never from a public name that happens to match.
 *
 * Exhaustive over `LLMVendor`, so adding a vendor fails typecheck until it is
 * placed here.
 */
import type { LLMVendor } from "../llm-vendor-defaults.js";

export const CATALOG_PROVIDERS_BY_VENDOR: Readonly<Record<LLMVendor, readonly string[]>> = {
  claude: ["anthropic"],
  openai: ["openai"],
  gemini: ["google"],
  copilot: ["github-copilot"],
  "azure-foundry": ["azure"],
  "vertex-ai": ["google-vertex", "google-vertex-anthropic"],
  "openai-compatible": [],
  openrouter: ["openrouter"],
  deepseek: ["deepseek"],
  xai: ["xai"],
  together: ["togetherai"],
  fireworks: ["fireworks-ai"],
  groq: ["groq"],
  poolside: ["poolside"],
  cerebras: ["cerebras"],
  sambanova: [],
  nebius: ["nebius"],
  baseten: ["baseten"],
  requesty: ["requesty"],
  litellm: [],
  huggingface: ["huggingface"],
  "vercel-ai-gateway": ["vercel"],
  "vercel-v0": [],
  aihubmix: ["aihubmix"],
  hicap: [],
  "nous-research": [],
  "huawei-cloud-maas": [],
  wandb: ["wandb"],
  xiaomi: ["xiaomi"],
  kilo: ["kilo"],
  zai: ["zai"],
  "zai-coding-plan": ["zai-coding-plan"],
  // DashScope's mainland endpoint (the vendors' baseUrl host), not the
  // international `alibaba` provider: the two list different models.
  qwen: ["alibaba-cn"],
  "qwen-code": ["alibaba-cn"],
  // Volcengine Ark, the doubao baseUrl host.
  doubao: ["volcengine"],
  mistral: ["mistral"],
  moonshot: ["moonshotai"],
  asksage: [],
  // Local runtimes serve whatever the user loaded; a public entry of the same
  // name says nothing about this machine's build of it.
  ollama: [],
  lmstudio: [],
  oca: [],
};

/** Every catalog provider some vendor maps to, sorted: what the bundled snapshot keeps. */
export function catalogProviderIds(): string[] {
  return [...new Set(Object.values(CATALOG_PROVIDERS_BY_VENDOR).flat())].sort();
}
