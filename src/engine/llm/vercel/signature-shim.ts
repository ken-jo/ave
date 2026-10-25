import { createLogger } from "../../../lib/logger.js";
const log = createLogger("signature-shim");

// Skip unsigned thinking blocks rather than replay an invalid signed echo.

/** Inspect only signed-wire parts; missing signatures require skipping the next-turn echo. */
export function extractSignatureSafely(
  reasoningPart: unknown,
): string | null {
  const sig = (reasoningPart as {
    providerMetadata?: { anthropic?: { signature?: unknown } };
  })?.providerMetadata?.anthropic?.signature;
  if (typeof sig !== "string" || sig.length === 0) {
    // eslint-disable-next-line no-console
    log.warn(
      "reasoning block missing signature — skipping the verbatim echo",
    );
    return null;
  }
  return sig;
}
