export const XLSX_EDIT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  backupBytes: 8 * 1024 * 1024,
  maxValueChars: 32767,
});

export type XlsxCellValue = string | number | boolean | null;
export type XlsxPanelEditRequest =
  | { action: "enable"; token: string }
  | { action: "release"; token: string }
  | { action: "cell"; token: string; row: number; column: number }
  | { action: "save"; token: string; row: number; column: number; value: XlsxCellValue };
export type XlsxPanelEditError = "invalid-request" | "unauthorized" | "expired" | "stale-file"
  | "permission-denied" | "edit-unavailable" | "unsupported-cell" | "backup-exists" | "edit-failed" | "busy";
export type XlsxPanelEditResult =
  | { ok: true; action: "enable" | "release" }
  | { ok: true; action: "cell"; value: XlsxCellValue; formula: boolean }
  | { ok: true; action: "save" }
  | { ok: false; error: XlsxPanelEditError };

/** Private renderer payloads carry only a host-issued identity and one bounded scalar edit. */
export function isXlsxPanelEditRequest(value: unknown): value is XlsxPanelEditRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token)) return false;
  const keys = request.action === "enable" || request.action === "release" ? ["action", "token"]
    : request.action === "cell" ? ["action", "token", "row", "column"]
      : request.action === "save" ? ["action", "token", "row", "column", "value"] : [];
  if (keys.length === 0 || Object.keys(request).length !== keys.length || keys.some((key) => !Object.hasOwn(request, key))) return false;
  if (request.action === "enable" || request.action === "release") return true;
  if (!Number.isSafeInteger(request.row) || (request.row as number) < 0 || (request.row as number) >= 1_048_576
    || !Number.isSafeInteger(request.column) || (request.column as number) < 0 || (request.column as number) >= 16_384) return false;
  if (request.action === "cell") return true;
  return request.value === null || typeof request.value === "boolean"
    || (typeof request.value === "number" && Number.isFinite(request.value))
    || (typeof request.value === "string" && request.value.length <= XLSX_EDIT_LIMITS.maxValueChars);
}
