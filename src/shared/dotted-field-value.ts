/**
 * Dotted-field selection over a tool's finalized input — the SELECTION half of
 * "which filesystem paths does this tool call touch".
 *
 * A tool declares its path-bearing arguments as `pathFields` (builtins on the
 * `Tool` descriptor; plugin tools via `_meta["ave/pathFields"]`). Two
 * consumers read that declaration off the same input object:
 *
 *   • `tools/pipeline/path-extraction.ts` — resolves the selected values to
 *     absolute paths for the ApprovalGate sensitive-path block and Layer-1
 *     scope check;
 *   • `permissions/reviewer/risk-classifier.ts` — canonicalizes the selected
 *     values for its containment rules.
 *
 * Only the SELECTION is shared here. The two consumers deliberately normalize
 * the selected values differently, and this module does not reconcile that —
 * see `permissions/reviewer/__tests__/declared-path-resolution-divergence.test.ts`,
 * which pins the current difference so a change to it has to be deliberate.
 *
 * Kept in `shared/` because neither consumer's layer may depend on the other's.
 */

import { parsePatchEnvelope, patchOperationPaths } from "./patch-envelope.js";

/**
 * Read `field` (a dot-separated path) out of `input`.
 *
 * Refuses to traverse INTO an array: a segment that lands on an array stops the
 * walk. Callers treat a final array value as a list of candidates, so allowing
 * numeric-index traversal would make `files.0` and `files` disagree about how
 * many paths a call touches. An empty segment (`"a..b"`, `".a"`) is a malformed
 * declaration and yields `undefined` rather than the container object.
 */
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

/**
 * Declaration suffix for a field holding patch-envelope text (`apply_patch`'s
 * `patch`): the paths are the files the patch names, not the field value.
 */
export const PATCH_ENVELOPE_PATH_FIELD_SUFFIX = "#patch-envelope";

/**
 * The candidate path values one `pathFields` entry selects from `input`: an
 * array value is a list of candidates, and a `#patch-envelope` entry yields
 * the paths its patch text names. Patch text that does not parse throws: the
 * tool's input schema refuses it first, so reaching here with one is a
 * contract violation, never a call that declares no path.
 */
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
