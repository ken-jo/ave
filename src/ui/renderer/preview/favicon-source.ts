/** Image schemes admitted by the renderer's img-src policy, alongside same-origin paths. */
export const FAVICON_SCHEMES = ["data:", "blob:", "ave-content:"] as const;

export function faviconSource(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
  if (FAVICON_SCHEMES.some((scheme) => value.startsWith(scheme))) return value;
  // Relative paths use 'self'; network-path references would escape that origin.
  if (!/^[a-z][a-z\d+.-]*:/i.test(value) && !/[\\\s]/.test(value) && !value.startsWith("//")) return value;
  return null;
}
