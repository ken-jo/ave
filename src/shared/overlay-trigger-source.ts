/**
 * Overlay trigger source naming.
 *
 * The `overlay:*` tag shape belongs to the PLUGIN row of the staged-origin table
 * (`shared/staged-origins.ts`), which also owns that origin's envelope, its
 * force-ask membership, and its model-facing guidance. This module builds the
 * trigger-spec validator's rule on that pattern, so the gate that rejects a
 * malformed `source` and the parser that reads provenance out of the envelope can
 * never disagree about what `overlay:*` means.
 *
 * The envelope tag itself is still spelled `imported-from-proactive` because
 * plugins may already author that wrapper.
 */
import { stagedOriginFor } from "./staged-origins.js";

const OVERLAY_KIND = stagedOriginFor("plugin-emitted");

/**
 * Strict `overlay:<name>` shape — rejects "overlay:", "overlay:_x",
 * "overlay:Bad/Path". Fail-closed: a non-matching source is never enveloped.
 */
const OVERLAY_TRIGGER_SOURCE_PATTERN = OVERLAY_KIND.sourcePattern;

/** Longest `source` a plugin may pass; bounds what reaches audit rows and the envelope. */
const PLUGIN_OVERLAY_SOURCE_MAX_LENGTH = 128;

/**
 * Whether a plugin may use `source` for an overlay trigger: the strict
 * `overlay:<name>` shape, bounded, and without `--`. The alert pipeline mints
 * `overlay:<pluginId>--<kind>` (and `overlay:host--<kind>` for host kinds);
 * neither id may contain `--`, so refusing it here is what keeps those
 * sources out of every plugin's reach.
 */
export function isPluginOverlaySource(source: string): boolean {
  return (
    source.length <= PLUGIN_OVERLAY_SOURCE_MAX_LENGTH
    && OVERLAY_TRIGGER_SOURCE_PATTERN.test(source)
    && !source.includes("--")
  );
}
