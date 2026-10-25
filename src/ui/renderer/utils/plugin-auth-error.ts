const SAFE_PLUGIN_AUTH_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

function stringField(value: unknown, key: "code" | "error" | "message"): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

export function sanitizePluginAuthErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim();
  return SAFE_PLUGIN_AUTH_ERROR_CODE.test(code) ? code : null;
}

/** Prefer explicit sanitized code/error fields, then bracketed message codes; user-facing localization stays at the caller. */
export function extractPluginAuthErrorCode(err: unknown): string | null {
  const explicitCode =
    sanitizePluginAuthErrorCode(stringField(err, "code")) ??
    sanitizePluginAuthErrorCode(stringField(err, "error"));
  if (explicitCode) return explicitCode;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : stringField(err, "message");
  const bracketCode = message?.match(/\[([A-Za-z0-9][A-Za-z0-9._:-]{0,80})\]/)?.[1];
  return sanitizePluginAuthErrorCode(bracketCode);
}
