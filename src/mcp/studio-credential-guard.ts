/** Compare raw and URL percent forms before a connector value can leave Studio. */
function stringContainsCredential(value: string, credential: string): boolean {
  if (value.includes(credential) || value.includes(encodeURIComponent(credential))) return true;
  try { return decodeURIComponent(value).includes(credential); }
  catch { return false; }
}

export function containsStoredCredential(value: unknown, credential: string): boolean {
  if (!credential) return false;
  if (typeof value === "string") return stringContainsCredential(value, credential);
  if (Array.isArray(value)) return value.some((item) => containsStoredCredential(item, credential));
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, item]) =>
    stringContainsCredential(key, credential) || containsStoredCredential(item, credential));
  return false;
}
