/** Untrusted toast fields need length limits and C0/DEL removal to protect single-line layout and logs; C1 is retained
 * because inputs are UTF-16 strings, not decoded bytes. */
export const TOAST_FIELD_MAX = 120;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
export function sanitizeToastField(input: unknown, max: number = TOAST_FIELD_MAX): string {
  return String(input ?? "unknown").replace(CONTROL_CHARS, "").slice(0, max);
}
