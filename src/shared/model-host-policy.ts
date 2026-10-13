/**
 * Host-owned model policy: the values Ave decides for itself rather than
 * reads from a model's description (issue #2501;
 * `docs/design/model-capability-catalog.md` §8).
 *
 * The model catalog, an endpoint's `/models` report and the user's settings
 * describe a model. What is here is not a description of any model: it is how
 * Ave budgets one nobody describes, how it throttles, and how it shapes a
 * request on the wire. None of it may be filled from a model name standing in
 * for a fact the catalog owns (a window, a price, a modality, a reasoning
 * level).
 *
 * Pure and browser-safe: the renderer's context ring reads it too.
 */

// ── Budget defaults ──────────────────────────────────────────────────────────

/**
 * The host's default request for an API-backed chat round's output, used when
 * the user set none. A host budget, not a model's maximum: the effective
 * limit is this or the user's value, clamped to the model's output ceiling
 * (`resolveOutputTokenLimit` in `context-budget.ts`).
 */
export const DEFAULT_LLM_OUTPUT_TOKEN_LIMIT = 32_000;

/**
 * The window budgeted for a model whose window nobody states: not the user,
 * not the endpoint's report, not the catalog. A guess, reported as source
 * `fallback` so the run record and the engine's warning say so.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * The largest window a declared or reported value is believed at.
 *
 * Above this the number is far likelier to be a typo or a malformed field than
 * a real deployment: an extra digit on 229,376 reads as 2,293,760, whose
 * preflight threshold no conversation ever reaches, so compaction never runs
 * again and the turn dies on a provider context error instead. The largest
 * window any model publishes today is about 2M, so this admits every real
 * model while refusing an order of magnitude past it.
 */
export const MAX_CREDIBLE_CONTEXT_WINDOW = 4_000_000;

// ── Throttling ───────────────────────────────────────────────────────────────

interface TpmDefaultRow {
  /** The vendors whose requests this limit throttles; an Azure deployment of the model shares it. */
  readonly vendors: readonly string[];
  /** Any model id that begins with this one, compared without regard to case. */
  readonly idPrefix: string;
  readonly tokensPerMinute: number;
}

/**
 * Tokens-per-minute limits an organization's default OpenAI tier enforces on
 * a model whose prompt can exceed them: a 400K window behind a 200K TPM limit
 * (observed: 429 "Limit 200000"). Not a model fact — an account's throttle —
 * so it lives with the host's defaults and caps the compaction threshold.
 */
const TPM_DEFAULTS: readonly TpmDefaultRow[] = [
  { vendors: ["openai", "azure-foundry"], idPrefix: "gpt-5.4-mini", tokensPerMinute: 200_000 },
  { vendors: ["openai", "azure-foundry"], idPrefix: "gpt-5.4-nano", tokensPerMinute: 200_000 },
];

/** The host's TPM default for a vendor's model, or `undefined` when none applies. */
export function hostTpmDefault(vendor: string, model: string): number | undefined {
  const id = model.toLowerCase();
  return TPM_DEFAULTS.find((row) => row.vendors.includes(vendor) && id.startsWith(row.idPrefix))?.tokensPerMinute;
}

// ── Request shape ────────────────────────────────────────────────────────────
//
// Facts about the Anthropic wire, not about the model's capacity: the catalog
// lists Claude Sonnet 4.6 and Opus 4.6 at a 1M window with no note that the
// window needs a beta header, and it carries no interleaving flag for
// Anthropic. Each row names the model ids it applies to and the request
// features it turns on.

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

interface ClaudeRequestShapeRow {
  /** Matched against the model id as the route names it. */
  readonly ids: RegExp;
  /** The 1M window is delivered only with the `context-1m-2025-08-07` beta header. */
  readonly context1MBeta?: true;
  /** Numeric thinking may span tool calls with the `interleaved-thinking-2025-05-14` beta header. */
  readonly interleavedNumericThinking?: true;
}

const CLAUDE_REQUEST_SHAPES: readonly ClaudeRequestShapeRow[] = [
  // Any id that begins with the family id: dated and suffixed snapshots too.
  { ids: /^claude-sonnet-4-6/iu, context1MBeta: true },
  { ids: /^claude-opus-4-6/iu, context1MBeta: true },
  // The numeric-thinking generations that support a budget across tool calls.
  // A release date or `-latest` does not change a generation's capabilities;
  // Sonnet 4.1 does not exist, so it is not listed.
  { ids: /^claude-opus-4(?:-(?:0|1|5))?(?:-(?:\d{8}|latest))?$/iu, interleavedNumericThinking: true },
  { ids: /^claude-sonnet-4(?:-(?:0|5))?(?:-(?:\d{8}|latest))?$/iu, interleavedNumericThinking: true },
];

/** The request-shape features the Anthropic wire carries for a model. */
export interface ClaudeRequestShape {
  readonly context1MBeta: boolean;
  readonly interleavedNumericThinking: boolean;
}

export function claudeRequestShape(model: string): ClaudeRequestShape {
  const rows = CLAUDE_REQUEST_SHAPES.filter((row) => row.ids.test(model));
  return {
    context1MBeta: rows.some((row) => row.context1MBeta === true),
    interleavedNumericThinking: rows.some((row) => row.interleavedNumericThinking === true),
  };
}

/**
 * The `anthropic-beta` values a Claude request carries, in this order: the 1M
 * window opt-in for a model that needs it, and interleaved thinking when this
 * request sends numeric thinking with tools to a generation that supports it.
 */
export function claudeBetaHeaders(request: { context1MBeta: boolean; interleavedThinking: boolean }): string[] {
  return [
    ...(request.context1MBeta ? [CONTEXT_1M_BETA] : []),
    ...(request.interleavedThinking ? [INTERLEAVED_THINKING_BETA] : []),
  ];
}
