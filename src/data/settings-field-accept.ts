/** Absent fields are normal; invalid fields warn once with the field name and retained value. */
import { createLogger } from "../lib/logger.js";

const log = createLogger("settings");

export interface FieldRejection {
  readonly reason: string;
  readonly verb: string;
}

export const STORED_FIELD: FieldRejection = Object.freeze({
  reason: "invalid",
  verb: "using default",
});

export const PATCHED_FIELD: FieldRejection = Object.freeze({
  reason: "patch ignored",
  verb: "keeping",
});

/** Initialize target with the retained default or live value before validation so rejection warnings stay accurate. */
export function acceptField<T extends object, K extends keyof T>(
  target: T,
  key: K,
  raw: unknown,
  accept: (value: unknown) => boolean,
  block: string,
  rejection: FieldRejection,
): void {
  acceptNormalizedField(
    target,
    key,
    raw,
    (value) => (accept(value) ? (value as T[K]) : undefined),
    block,
    rejection,
  );
}

/** Normalize returns the stored value or undefined to reject; use transforms for clamped and bounded fields. */
export function acceptNormalizedField<T extends object, K extends keyof T>(
  target: T,
  key: K,
  raw: unknown,
  normalize: (value: unknown) => T[K] | undefined,
  block: string,
  rejection: FieldRejection,
): void {
  const normalized = normalize(raw);
  if (normalized !== undefined) {
    target[key] = normalized;
    return;
  }
  // Do not warn for absent settings.
  if (raw === undefined) return;
  log.warn(
    `${block}.${String(key)} ${rejection.reason} (received ${JSON.stringify(raw)}), ${rejection.verb} %s`,
    target[key],
  );
}

export function isBooleanValue(value: unknown): boolean {
  return typeof value === "boolean";
}
