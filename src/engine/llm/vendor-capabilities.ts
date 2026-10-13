/**
 * Vendor + model vision capability lookup.
 *
 * The composer allows attaching images regardless of the active model — users
 * may switch models before sending. supportsVision() then decides whether the
 * turn may go out at all: a model that cannot consume images refuses the send,
 * so the user removes them or picks another model. No send drops image parts on
 * the way to the provider.
 *
 * The route's stated input modalities decide: the user's declaration or named
 * entry, then the endpoint report, then the model catalog's input list. Only an
 * `image` there counts. The catalog's `attachment` flag does not: the composer
 * sends a file as a path the agent reads with its tools, never as a file part
 * the model has to accept.
 *
 * Where nothing states the modalities, the turn may not carry images: support
 * that nobody states is not assumed from the model's name. The refusal names
 * Settings → Model → Image input → Supported, the declaration that states it.
 */
import type { LLMVendor } from "./types.js";
import { isSelfHostedVllmVendor } from "../../shared/llm-vendor-defaults.js";
import { resolveInputModalities, type RouteInputModalities } from "../../shared/context-budget.js";
import type {
  MarketplaceInstalledProviderPreset,
  MarketplaceProviderPackageAsset,
} from "../../shared/marketplace-package-assets.js";

type ProviderPackageCapabilitySource =
  | Pick<MarketplaceInstalledProviderPreset, "capabilities">
  | Pick<MarketplaceProviderPackageAsset, "capabilities">
  | undefined;

/**
 * Whether a turn on this model may carry images.
 *
 * `route` is the active route's resolution (`resolveContextWindowForRoute`),
 * for a caller that has it: its `inputModalities` already apply user declarations,
 * endpoint reports and catalog entries in that order, and when it has none
 * nobody stated that the model takes images. It must not be re-resolved by name
 * here: a named entry missing from the catalog answers nothing, and a name match
 * could be a different model. A caller without a route (a direct model call)
 * gets the catalog entry the vendor's model id resolves to.
 */
export function supportsVision(
  vendor: LLMVendor,
  model: string,
  route?: RouteInputModalities,
): boolean {
  const m = model.trim();
  if (m.length === 0) return false;
  const stated = route ? route.inputModalities : resolveInputModalities({ vendor, model: m });
  return stated?.input.includes("image") === true;
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
