/** Inspect decoded strings; JSON escaping must not change the credential check. */
export function containsStoredCredential(value: unknown, credential: string): boolean {
  if (!credential) return false;
  if (typeof value === "string") return value.includes(credential);
  if (Array.isArray(value)) return value.some((item) => containsStoredCredential(item, credential));
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, item]) =>
    key.includes(credential) || containsStoredCredential(item, credential));
  return false;
}
