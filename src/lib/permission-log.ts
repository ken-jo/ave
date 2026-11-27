import { createHmac, randomBytes } from "node:crypto";
import { maskSensitiveData } from "../shared/dlp.js";
import { createLogger } from "./logger.js";

let log: ReturnType<typeof createLogger> | undefined;

type PermissionLogFields = Readonly<Record<string, string | number | boolean | undefined>>;
type PermissionLogLevel = "info" | "warn";

export function logPermissionEvent(
  event: string,
  fields: PermissionLogFields,
  level: PermissionLogLevel = "info",
): void {
  try {
    log ??= createLogger("permissions", true);
    log[level]({ ...fields, event }, event);
  } catch {
    // Log delivery cannot affect permission or execution state.
  }
}

export function permissionLogId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
    && maskSensitiveData(value).detections.length === 0
    ? value
    : undefined;
}

let correlationKey: Buffer | undefined;

/** Keep provider IDs out of logs while correlating events within this process. */
export function permissionLogCorrelationId(toolUseId: string | undefined): string | undefined {
  if (toolUseId === undefined) return undefined;
  try {
    correlationKey ??= randomBytes(32);
    return createHmac("sha256", correlationKey).update(toolUseId).digest("hex").slice(0, 32);
  } catch {
    return undefined;
  }
}
