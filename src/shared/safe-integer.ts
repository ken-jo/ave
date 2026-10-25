/** Keep numeric guards dependency-free so main and renderer can share them without importing each other. */

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Rejects invalid input with the caller-supplied stable error code or message. */
export function requirePositiveInteger(value: unknown, message: string): number {
  if (!isPositiveSafeInteger(value)) throw new RangeError(message);
  return value;
}
