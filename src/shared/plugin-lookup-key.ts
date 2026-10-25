/** Main and renderer must normalize catalog lookup keys identically so management and repair resolve the same package. */

export function normalizePluginLookupKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/@[^/@]+$/, "")
    .replace(/^ave-plugin-/, "")
    .replace(/^plugin-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
