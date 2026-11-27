import { createLogger } from "./logger.js";

const log = createLogger("permissions");

export function logPermissionEvent(
  event: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>>,
  level: "info" | "warn" = "info",
): void {
  try {
    log[level]({ ...fields, event }, event);
  } catch {
    // Log delivery cannot affect permission or execution state.
  }
}

export function permissionLogId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
    ? value
    : undefined;
}
