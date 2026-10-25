// Shared failures use closed categories and fixed sentences, never raw errors, secrets, or paths.
// Derive once at publication and revalidate at every serialization boundary.

export const TURN_FAILURE_CATEGORIES = Object.freeze([
  "provider",
  "auth",
  "rate-limit",
  "context",
  "network",
  "model",
  "internal",
] as const);

export type TurnFailureCategory = (typeof TURN_FAILURE_CATEGORIES)[number];

export interface TurnFailureSummary {
  readonly category: TurnFailureCategory;
  // Display-safe sentence, never raw error text.
  readonly summary: string;
}

// Re-admission always applies this defensive bound.
export const MAX_TURN_FAILURE_SUMMARY_CHARS = 200;

// Classify raw error text without copying any of it into shared output.
const TURN_FAILURE_SUMMARY_TEXT: Readonly<Record<TurnFailureCategory, string>> = Object.freeze({
  provider: "The model provider returned an error.",
  auth: "The model API key was rejected. Check the key in settings.",
  "rate-limit": "The model rate limit was hit. Retry shortly.",
  context: "The conversation exceeded the model context limit.",
  network: "The model request failed over the network.",
  model: "The configured model was not found.",
  internal: "An internal error stopped the turn.",
});

// Unknown classifier values fall through to notice-based defaults.
const CLASSIFIER_CATEGORY_TO_FAILURE: Readonly<Record<string, TurnFailureCategory>> = Object.freeze({
  "api-key": "auth",
  "rate-limit": "rate-limit",
  "context-length": "context",
  model: "model",
  network: "network",
  unknown: "provider",
});

const SYSTEM_NOTICE_TO_FAILURE: Readonly<
  Record<NonNullable<DeriveTurnFailureSummaryInput["systemNotice"]>, TurnFailureCategory>
> = Object.freeze({
  "context-error": "context",
  "stream-error": "provider",
});

export interface DeriveTurnFailureSummaryInput {
  readonly systemNotice?: "context-error" | "stream-error";
  // Validate opaque classification against the closed map so forged values cannot widen the union.
  readonly classifierCategory?: string;
}

/** Derive through fixed tables without copying any input error text. */
export function deriveTurnFailureSummary(
  input: DeriveTurnFailureSummaryInput,
): TurnFailureSummary {
  const category = resolveTurnFailureCategory(input);
  return { category, summary: TURN_FAILURE_SUMMARY_TEXT[category] };
}

function resolveTurnFailureCategory(
  input: DeriveTurnFailureSummaryInput,
): TurnFailureCategory {
  const classified = input.classifierCategory !== undefined
    && Object.hasOwn(CLASSIFIER_CATEGORY_TO_FAILURE, input.classifierCategory)
    ? CLASSIFIER_CATEGORY_TO_FAILURE[input.classifierCategory]
    : undefined;
  const noticed = input.systemNotice !== undefined
    ? SYSTEM_NOTICE_TO_FAILURE[input.systemNotice]
    : undefined;
  return classified ?? noticed ?? "internal";
}

/** Re-admit only known categories and two allowed fields; strip controls and bound sentence length. */
export function toSafeTurnFailureSummary(value: unknown): TurnFailureSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { readonly category?: unknown; readonly summary?: unknown };
  const category = candidate.category;
  if (
    typeof category !== "string"
    || !(TURN_FAILURE_CATEGORIES as readonly string[]).includes(category)
  ) {
    return undefined;
  }
  if (typeof candidate.summary !== "string") return undefined;
  const summary = boundedSummaryText(candidate.summary);
  if (summary.length === 0) return undefined;
  return { category: category as TurnFailureCategory, summary };
}

/** Bound UTF-16 length without splitting surrogate pairs. */
function boundedSummaryText(value: string): string {
  let output = "";
  for (let index = 0; index < value.length && output.length < MAX_TURN_FAILURE_SUMMARY_CHARS;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const isControl = (codePoint >= 0 && codePoint <= 0x1f) || codePoint === 0x7f;
    const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    if (!isControl && !isLoneSurrogate) {
      if (output.length + width > MAX_TURN_FAILURE_SUMMARY_CHARS) break;
      output += value.slice(index, index + width);
    }
    index += width;
  }
  return output.trim();
}
