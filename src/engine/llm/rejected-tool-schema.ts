// Parse the provider-rejected tool name rather than mirroring every strict schema rule.
import type { ProviderErrorDiagnostics } from "./provider-error-diagnostics.js";

const SCHEMA_REJECTION_MESSAGE_RE =
  /invalid[_ ]function[_ ]parameters|invalid schema for (?:function|tool)/i;

// Provider errors may quote the offending function name with single, double, or backtick quotes.
const REJECTED_FUNCTION_NAME_RE =
  /(?:function|tool)\s+['"`]([A-Za-z0-9_.-]+)['"`]/i;

/** Return only rejected names still in the current tool set so every retry strictly shrinks it. */
export function rejectedToolNameFromError(
  providerError: ProviderErrorDiagnostics | undefined,
  knownToolNames: readonly string[],
): string | undefined {
  if (!providerError) return undefined;

  const code = providerError.providerCode ?? "";
  const message = providerError.messagePreview ?? "";
  const isSchemaRejection =
    code.toLowerCase().includes("invalid_function_parameters") ||
    SCHEMA_REJECTION_MESSAGE_RE.test(message);
  if (!isSchemaRejection) return undefined;

  const named = message.match(REJECTED_FUNCTION_NAME_RE)?.[1];
  if (!named) return undefined;

  return knownToolNames.includes(named) ? named : undefined;
}

/** Keep rejected schemas excluded when scope rebuilds after activation or search. */
export function withoutDroppedTools<T extends { name: string }>(
  schemas: readonly T[],
  dropped: ReadonlySet<string>,
): T[] {
  return dropped.size === 0
    ? [...schemas]
    : schemas.filter((schema) => !dropped.has(schema.name));
}
