import { maskSensitiveData } from "../shared/dlp.js";
import { isPackagedElectronProcess } from "../boot/dev-flags.js";
import { createLogger } from "./logger.js";

let log: ReturnType<typeof createLogger> | undefined;
const useTestConsole = !isPackagedElectronProcess(process)
  && (process.env.VITEST !== undefined || process.env.NODE_ENV === "test");
const MAX_PENDING_EVENTS = 256;
const EVENTS_PER_TURN = 32;

type PermissionLogFields = Readonly<Record<string, string | number | boolean | undefined>>;
type PermissionLogLevel = "info" | "warn";

const pending: Array<{ event: string; fields: PermissionLogFields; level: PermissionLogLevel }> = [];
let dropped = 0;
let scheduled = false;

function scheduleDelivery(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    for (const { event, fields, level } of pending.splice(0, EVENTS_PER_TURN)) {
      deliver(event, fields, level);
    }
    if (dropped > 0) {
      deliver("permission_log_overflow", { dropped }, "warn");
      dropped = 0;
    }
    if (pending.length > 0) scheduleDelivery();
  }).unref();
}

export function logPermissionEvent(
  event: string,
  fields: PermissionLogFields,
  level: PermissionLogLevel = "info",
): void {
  if (useTestConsole) {
    deliver(event, fields, level);
    return;
  }
  if (pending.length >= MAX_PENDING_EVENTS) {
    dropped += 1;
    return;
  }
  pending.push({ event, fields, level });
  scheduleDelivery();
}

function deliver(event: string, fields: PermissionLogFields, level: PermissionLogLevel): void {
  try {
    (log ??= createLogger("permissions", true))[level]({ ...fields, event }, event);
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
