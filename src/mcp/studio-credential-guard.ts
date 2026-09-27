/** Decode valid percent runs independently so unrelated malformed text cannot hide a credential. */
function tolerantPercentDecode(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/gu, (run) => {
    try { return decodeURIComponent(run); }
    catch { return run; }
  });
}

function stringContainsCredential(value: string, credential: string): boolean {
  if (value.includes(credential) || tolerantPercentDecode(value).includes(credential)) return true;
  try {
    const url = new URL(value);
    return [...url.searchParams.values()].some((part) => part.includes(credential)
      || tolerantPercentDecode(part).includes(credential));
  } catch { return false; }
}

export function containsStoredCredential(value: unknown, credential: string): boolean {
  if (!credential) return false;
  if (typeof value === "string") return stringContainsCredential(value, credential);
  if (Array.isArray(value)) return value.some((item) => containsStoredCredential(item, credential));
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, item]) =>
    stringContainsCredential(key, credential) || containsStoredCredential(item, credential));
  return false;
}
