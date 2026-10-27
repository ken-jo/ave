export function parseConfigurationObject(raw: string, allowEmpty = false): Record<string, unknown> {
  if (allowEmpty && raw.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings root is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function parsePolicyDocument(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(raw.trim() === "" ? "empty file; not valid JSON" : "not valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) throw new Error("version mismatch: expected 1");
  return record;
}
