/** Escape every regex metacharacter in literal ids and paths; glob translators intentionally use a different rule. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
