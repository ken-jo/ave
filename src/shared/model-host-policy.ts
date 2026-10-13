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
