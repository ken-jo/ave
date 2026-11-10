/** Guest pages may supply only image data admitted by the host renderer's image policy. */
export function guestFaviconSource(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
  return /^data:image\/[a-z\d.+-]+(?:;[^,]*)?,/i.test(value) ? value : null;
}
