/**
 * Vendor + model vision capability lookup.
 *
 * The composer allows attaching images regardless of the active model — users
 * may switch models before sending. supportsVision() then decides whether the
 * turn may go out at all: a model that cannot consume images refuses the send,
 * so the user removes them or picks another model. No send drops image parts on
 * the way to the provider.
 *
 * The model's stated input modalities decide (issue #2501): the endpoint's
 * `/models` report, else the model catalog's `modalities.input`. Only an
 * `image` there counts. The catalog's `attachment` flag does not: the composer
 * sends a file as a path the agent reads with its tools, never as a file part
 * the model has to accept.
 *
 * Where nothing states the modalities, the name rules below decide, as they
 * did before the catalog (slice 7 removes them). Their 2026-04 snapshot:
 *   - Anthropic Claude 3+ family supports vision (3, 3.5, 3.7, 4, 4.5, 4.6, 4.7).
 *   - OpenAI: gpt-4o, gpt-4-turbo, gpt-4-vision, gpt-5* all support vision.
 *           o1, o1-mini, o3-mini reasoning models do NOT (text-only).
 *           gpt-3.5* does NOT.
 *   - Google Gemini 1.5 / 2.x family all support vision.
 *   - GitHub Copilot routes via OpenAI/Anthropic models — assume false unless
 *     model name matches a known vision-capable upstream.
 *   - Azure Foundry / Vertex AI — defer to underlying model name.
 */
import type { LLMVendor } from "./types.js";
import {
  isOpenAICompatibleVendor,
  isSelfHostedVllmVendor,
} from "../../shared/llm-vendor-defaults.js";
import { resolveInputModalities, type RouteInputModalities } from "../../shared/context-budget.js";
import type {
  MarketplaceInstalledProviderPreset,
  MarketplaceProviderPackageAsset,
} from "../../shared/marketplace-package-assets.js";

type ProviderPackageCapabilitySource =
  | Pick<MarketplaceInstalledProviderPreset, "capabilities">
  | Pick<MarketplaceProviderPackageAsset, "capabilities">
  | undefined;

const NON_VISION_MODEL_PATTERNS = [
  /^o1(-mini|-preview)?$/i,
  /^o3-mini/i,
  /^gpt-3\.5/i,
  /^text-/i,
  /^claude-2/i,
  /^claude-instant/i,
];

const VISION_MODEL_PATTERNS = [
  /^claude-/i,
  /^gpt-4(o|-turbo|-vision|\.5|\.6)/i,
  /^gpt-5/i,
  /^gemini-/i,
];

/**
 * Whether a turn on this model may carry images.
 *
 * `route` is the active route's resolution (`resolveContextWindowForRoute`),
 * for a caller that has it: its `inputModalities` already weigh the endpoint's
 * report and the catalog entry the user named for the route, and when it has
 * none the name rules decide. It must not be re-resolved by name here: a named
 * entry missing from the catalog answers nothing, and a name match could be a
 * different model. A caller without a route (one row of a model list) gets the
 * catalog entry the vendor's model id resolves to.
 */
export function supportsVision(
  vendor: LLMVendor,
  model: string,
  route?: RouteInputModalities,
): boolean {
  const m = model.trim();
  if (m.length === 0) return false;
  const stated = route ? route.inputModalities : resolveInputModalities({ vendor, model: m });
  if (stated) return stated.input.includes("image");
  return supportsVisionByName(vendor, m);
}

function supportsVisionByName(vendor: LLMVendor, m: string): boolean {
  for (const re of NON_VISION_MODEL_PATTERNS) {
    if (re.test(m)) return false;
  }

  for (const re of VISION_MODEL_PATTERNS) {
    if (re.test(m)) return true;
  }

  switch (vendor) {
    case "claude":
      return true;
    case "gemini":
    case "vertex-ai":
      return true;
    case "openai":
    case "azure-foundry":
      return /^(gpt-4|gpt-5|chatgpt)/i.test(m);
    case "copilot":
      return /^(gpt-4|gpt-5|claude-)/i.test(m);
    default:
      if (isOpenAICompatibleVendor(vendor)) {
        return /^(gpt-4|gpt-5|claude-|gemini-|qwen|kimi|glm|mimo|llama|meta-llama|nvidia\/)/i.test(m);
      }
      // Defense-in-depth: callers occasionally `as LLMVendor`-cast a raw
      // string (settings load, IPC inputs). An unexpected vendor would
      // otherwise yield undefined at runtime and violate the declared
      // boolean return — fall back to "no vision" rather than silently
      // surfacing as falsey.
      return false;
  }
}

/**
 * finish_reason=length CONTINUATION capability. When a round ends truncated
 * (stopReason "max_tokens") the conversation loop re-invokes the model to
 * CONTINUE the partial answer instead of showing it cut off. The mechanism is
 * vLLM's native `continue_final_message` (zero-seam), so it lights up for the
 * self-hosted vLLM class ({@link isSelfHostedVllmVendor}: openai-compatible +
 * ollama + lmstudio + litellm) — NOT the commercial OpenAI-compatible gateways
 * (openrouter/groq/…), which do not honor `continue_final_message`. Other
 * vendors fall back to the existing truncation notice until their prefill path
 * is wired:
 *   - claude  → assistant-prefill (blocked while extended thinking is ON)
 *   - openai/gemini/copilot/azure-foundry/vertex → append partial + "continue"
 *     user reprompt + host stitch
 * Shares the {@link isSelfHostedVllmVendor} SOT with the adapter's
 * `chat_template_kwargs`/`continue_final_message` guard so the request-shaping
 * side and the capability side can never drift.
 */
export function vendorSupportsLengthContinuation(vendor: LLMVendor): boolean {
  return isSelfHostedVllmVendor(vendor);
}

export function providerPackageSupportsReviewerAdapter(
  metadata: ProviderPackageCapabilitySource,
): boolean {
  return metadata?.capabilities?.reviewerAdapter === true;
}
