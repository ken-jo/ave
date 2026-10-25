/** Build source validation from staged-origins.ts so validation and provenance parsing share the overlay grammar. */
import { stagedOriginFor } from "./staged-origins.js";

const OVERLAY_KIND = stagedOriginFor("plugin-emitted");

/** Fail closed for malformed overlay sources. */
const OVERLAY_TRIGGER_SOURCE_PATTERN = OVERLAY_KIND.sourcePattern;

/** Longest `source` a plugin may pass; bounds what reaches audit rows and the envelope. */
const PLUGIN_OVERLAY_SOURCE_MAX_LENGTH = 128;

/** Reserve `--` for host-minted alert sources so plugins cannot impersonate them. */
export function isPluginOverlaySource(source: string): boolean {
  return (
    source.length <= PLUGIN_OVERLAY_SOURCE_MAX_LENGTH
    && OVERLAY_TRIGGER_SOURCE_PATTERN.test(source)
    && !source.includes("--")
  );
}
