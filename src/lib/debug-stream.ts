/** Enable stream diagnostics only through explicit debug flags; prefer the renderer-safe preload bridge. */
function isFlagEnabled(value: unknown): boolean {
  return value === "1" || value === "true" || value === true;
}

export function isDebugStreamEnabled(): boolean {
  // Normal renderer code lacks process because nodeIntegration is disabled.
  if (typeof window !== "undefined" && window.ave?.env?.debugStream === true) {
    return true;
  }

  const importMetaEnv = (import.meta as { env?: Record<string, unknown> }).env;
  if (isFlagEnabled(importMetaEnv?.VITE_DEBUG_STREAM)) {
    return true;
  }

  return (
    typeof process !== "undefined" &&
    (isFlagEnabled(process.env?.VITE_DEBUG_STREAM) || isFlagEnabled(process.env?.AVE_DEBUG_STREAM))
  );
}

export function debugLog(scope: string, ...args: unknown[]): void {
  if (!isDebugStreamEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[ave-debug:${scope}]`, ...args);
}
