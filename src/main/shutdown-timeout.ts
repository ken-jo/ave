import {
  TOOL_TIMEOUT_POLICY,
  normalizeShutdownCleanupTimeoutMs,
} from "../shared/tool-timeout-policy.js";
import { resolveEnvBackedNumber } from "../shared/env-backed-settings.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("ave");
let invalidEnvWarnedOnce = false;

// Re-export the shared timeout-policy value for existing callers.
export const DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS =
  TOOL_TIMEOUT_POLICY.shutdownCleanupMs;

export type ShutdownCleanupResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

// Environment overrides saved settings, then the policy default; normalize both sources identically. Warn once for an unusable environment value so an
// invalid pin cannot silently defer to settings.
export function resolveShutdownCleanupTimeoutMs(
  settingMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  warnOnceOnUnusableEnvValue(env);
  return resolveEnvBackedNumber(
    "system.shutdownCleanupTimeoutMs",
    normalizeShutdownCleanupTimeoutMs(settingMs),
    env,
    DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  );
}

function warnOnceOnUnusableEnvValue(env: NodeJS.ProcessEnv): void {
  const raw = env.AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return;
  if (normalizeShutdownCleanupTimeoutMs(raw) !== undefined) return;
  if (invalidEnvWarnedOnce) return;
  invalidEnvWarnedOnce = true;
  log.warn(
    `shutdown-timeout: env value ${JSON.stringify(raw)} is not a positive number; ` +
      "falling back to the saved setting or the default " +
      `${DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS}ms.`,
  );
}

// Abort cleanup on deadline or rejection; callers must honor cancellation so ongoing writes cannot race forced process exit.
export async function runCleanupWithHardTimeout(
  cleanup: (signal: AbortSignal) => Promise<void> | void,
  timeoutMs: number,
): Promise<ShutdownCleanupResult> {
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;

  const cleanupPromise: Promise<ShutdownCleanupResult> = Promise.resolve()
    .then(() => cleanup(controller.signal))
    .then(() => ({ status: "completed" as const }))
    .catch((error: unknown) => ({ status: "failed" as const, error }));

  const timeoutPromise = new Promise<ShutdownCleanupResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ status: "timed-out" });
    }, normalizedTimeoutMs);
    timeout.unref?.();
  });

  const result = await Promise.race([cleanupPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  if (result.status !== "completed") {
    // Abort on failure too so any partially-running sub-tasks tear down before the caller force-kills children.
    controller.abort();
  }
  return result;
}
