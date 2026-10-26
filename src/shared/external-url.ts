/** Parse URLs structurally: allow HTTP(S) only and reject embedded credentials before any external-navigation sink. */
export type ExternalUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: "invalid-url" }
  | { ok: false; error: "malformed-url" }
  | { ok: false; error: "embedded-credentials" }
  | { ok: false; error: "disallowed-protocol"; protocol: string };

export function validateExternalUrl(input: unknown): ExternalUrlValidation {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "invalid-url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "malformed-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "disallowed-protocol", protocol: parsed.protocol };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "embedded-credentials" };
  }
  return { ok: true, url: parsed.toString() };
}
