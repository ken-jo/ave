import { isRecord } from "./is-record.js";

export interface DocumentOpenRequest {
  requestId: string;
  sessionId: string;
  path: string;
  expiresAt: number;
}
export interface DocumentOpenAck {
  requestId: string;
  sessionId: string;
  opened: boolean;
}

export function parseDocumentOpenRequest(value: unknown): DocumentOpenRequest | null {
  if (!isRecord(value) || typeof value.requestId !== "string" || value.requestId.length === 0
    || typeof value.sessionId !== "string" || value.sessionId.length === 0
    || typeof value.path !== "string" || value.path.length === 0
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) return null;
  return { requestId: value.requestId, sessionId: value.sessionId, path: value.path, expiresAt: value.expiresAt };
}
export function parseDocumentOpenAck(value: unknown): DocumentOpenAck | null {
  if (!isRecord(value) || typeof value.requestId !== "string" || value.requestId.length === 0
    || typeof value.sessionId !== "string" || value.sessionId.length === 0 || typeof value.opened !== "boolean") return null;
  return { requestId: value.requestId, sessionId: value.sessionId, opened: value.opened };
}
