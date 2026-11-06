import type { IpcMainInvokeEvent } from "electron";
import type { AuditLogger } from "../audit/audit-logger.js";
import { redactFsPath } from "../audit/dlp-filter.js";

// Accept only trusted packaged or local-dev frames; missing frames fail closed after navigation or destruction.
export function validateSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  const frame = event?.senderFrame;
  if (!frame) return false;
  const rawUrl = frame.url ?? "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return true;
    if (url.protocol === "http:" && url.hostname === "localhost") return true;
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

// Host controls share the protocol and frame-presence boundary; app resources have a separate per-server origin.
export function validateHostRendererSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  return validateSender(event);
}

export const UNAUTHORIZED_FRAME = { ok: false, error: "unauthorized-frame" as const };

// Redact filesystem identity from rejected-frame URLs before writing the shared audit entry.
export function auditUnauthorized(
  auditLogger: AuditLogger,
  channel: string,
  event: IpcMainInvokeEvent,
): void {
  auditLogger.log({
    timestamp: new Date().toISOString(),
    sessionId: "ipc-guard",
    type: "warn",
    input: JSON.stringify({
      channel,
      frameUrl: redactFsPath(event?.senderFrame?.url ?? ""),
    }),
  });
}
