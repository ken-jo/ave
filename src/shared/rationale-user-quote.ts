/** Shared shape constraints for exact native-user evidence. */
export const RATIONALE_USER_QUOTE_MIN_LENGTH = 12;
export const RATIONALE_USER_QUOTE_MAX_LENGTH = 2_000;
export const RATIONALE_USER_QUOTE_PATTERN = String.raw`^(?=[^\p{L}\p{N}]*[\p{L}\p{N}]+(?:[^\p{L}\p{N}]+[\p{L}\p{N}]+){2})\s*\S[\s\S]{10,}\S\s*$`;
const QUOTE_LENGTH_PATTERN = new RegExp(RATIONALE_USER_QUOTE_PATTERN, "u");
const BOUNDARY_PATTERN = /[\s\p{P}]/u;

export function isRationaleUserQuote(value: unknown): value is string {
  return typeof value === "string" && value.length <= RATIONALE_USER_QUOTE_MAX_LENGTH &&
    value.trim().length >= RATIONALE_USER_QUOTE_MIN_LENGTH && QUOTE_LENGTH_PATTERN.test(value);
}

/** Match exact source bytes at word boundaries; normalization would alter the evidence. */
export function hasRationaleUserQuote(message: string, quote: unknown): quote is string {
  if (!isRationaleUserQuote(quote)) return false;
  for (let offset = message.indexOf(quote); offset !== -1; offset = message.indexOf(quote, offset + 1)) {
    const end = offset + quote.length;
    if ((offset === 0 || BOUNDARY_PATTERN.test(message[offset - 1]!)) &&
        (end === message.length || BOUNDARY_PATTERN.test(message[end]!))) return true;
  }
  return false;
}
