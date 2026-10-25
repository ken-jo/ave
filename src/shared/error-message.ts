/** Keep error conversion dependency-free because it runs inside catches across boot, shutdown, and isolation. */
import { isRecord } from "./is-record.js";

/** Message of an `Error`; `String()` of anything else. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append only transport cause.code; cause messages can repeat sensitive request URLs. */
export function errorMessageWithCauseCode(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof Error) || !isRecord(error.cause)) return message;
  const code = error.cause.code;
  return typeof code === "string" && code.length > 0
    ? `${message} (${code})`
    : message;
}

/** Read Error or record messages first; otherwise serialize, falling back to String for unsupported values. */
export function errorMessageOrSerialized(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
