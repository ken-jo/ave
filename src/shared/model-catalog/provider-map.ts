/** Map vendors only to catalog providers on their own API host; unmapped routes cannot inherit public limits by name. */
import type { LLMVendor } from "../llm-vendor-defaults.js";

export const CATALOG_PROVIDERS_BY_VENDOR: Readonly<Record<LLMVendor, readonly string[]>> = {
  claude: ["anthropic"],
  openai: ["openai"],
  gemini: ["google"],
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
  // Regional endpoints list different models; use the provider matching the configured host.
  qwen: ["alibaba-cn"],
  "qwen-code": ["alibaba-cn"],
  doubao: ["volcengine"],
  mistral: ["mistral"],
  moonshot: ["moonshotai"],
  asksage: [],
  // Local model names cannot establish the identity of the loaded build.
  ollama: [],
  lmstudio: [],
  oca: [],
};

/** Sorted provider union defines the bundled snapshot scope. */
export function catalogProviderIds(): string[] {
  return [...new Set(Object.values(CATALOG_PROVIDERS_BY_VENDOR).flat())].sort();
}
