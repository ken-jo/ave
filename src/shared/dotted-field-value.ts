/** Share path-field selection only; reviewer and executor intentionally retain distinct normalization rules. */

import { parsePatchEnvelope, patchOperationPaths } from "./patch-envelope.js";

/** Stop at arrays and return them whole; numeric traversal would undercount paths. Empty segments return undefined. */
export function getDottedFieldValue(
  input: Record<string, unknown>,
  field: string,
): unknown {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (segment.length === 0) return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Patch-envelope fields select paths named by the patch rather than treating patch text as a path. */
export const PATCH_ENVELOPE_PATH_FIELD_SUFFIX = "#patch-envelope";

/** Malformed patch text throws as a schema-contract violation, never an empty path declaration. */
export function selectDeclaredPathValues(
  input: Record<string, unknown>,
  field: string,
): unknown[] {
  if (field.endsWith(PATCH_ENVELOPE_PATH_FIELD_SUFFIX)) {
    const text = getDottedFieldValue(input, field.slice(0, -PATCH_ENVELOPE_PATH_FIELD_SUFFIX.length));
    if (typeof text !== "string") {
      throw new Error(`path field '${field}' requires patch text`);
    }
    const parsed = parsePatchEnvelope(text);
    if (!parsed.ok) throw new Error(`path field '${field}': invalid patch: ${parsed.error}`);
    return patchOperationPaths(parsed.operations);
  }
  const candidate = getDottedFieldValue(input, field);
  return Array.isArray(candidate) ? candidate : [candidate];
}
