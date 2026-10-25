/** Share common-name validation across settings, profile normalization, and platform certificate lookup. */

/** The default CN is a placeholder; organizations with another name must configure it. */
export const DEFAULT_CORP_CA_COMMON_NAME = "Corporate Root CA";

/** Allow some slack beyond the certificate CN standard for nonconforming corporate certificates. */
export const MAX_CORP_CA_COMMON_NAME_LENGTH = 256;

/** Pass names as data, never shell text; reject blank, oversized, or control-bearing names. */
export function normalizeCorpCaCommonName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_CORP_CA_COMMON_NAME_LENGTH) return null;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}
