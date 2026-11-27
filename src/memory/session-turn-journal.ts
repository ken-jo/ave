// Persist completed rows and an in-flight partial snapshot so mid-turn crashes retain progress.
import { unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { writeUtf8FileAtomic } from "../lib/atomic-file.js";
import { isRecord } from "../shared/is-record.js";

const TURN_INFLIGHT_FILE = "turn-inflight.json";

export const HOST_EXIT_INTERRUPTION = "host-exit" as const;

export const MAX_TURN_PARTIAL_CHARS = 2_000_000;

export interface TurnInflightPartial {
  /** The id the round's committed assistant row will carry; a row with it on disk supersedes this partial. */
  messageId: string;
  content: string;
  thought?: string;
  updatedAt: number;
}

export interface TurnInflightRecord {
  v: 1;
  startedAt: number;
  partial?: TurnInflightPartial;
}

export function turnInflightPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId, TURN_INFLIGHT_FILE);
}

// Treat user-writable sidecars as untrusted and ignore shapes the writer could not produce.
export function parseTurnInflightRecord(raw: string): TurnInflightRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
  const record: TurnInflightRecord = { v: 1, startedAt: parsed.startedAt };
  if (parsed.partial !== undefined) {
    const partial = parsed.partial;
    if (
      !isRecord(partial)
      || typeof partial.messageId !== "string"
      || partial.messageId.length === 0
      || partial.messageId.length > 256
      || typeof partial.content !== "string"
      || typeof partial.updatedAt !== "number"
      || !Number.isFinite(partial.updatedAt)
      || (partial.thought !== undefined && typeof partial.thought !== "string")
    ) {
      return null;
    }
    record.partial = {
      messageId: partial.messageId,
      content: partial.content.slice(0, MAX_TURN_PARTIAL_CHARS),
      ...(typeof partial.thought === "string" ? { thought: partial.thought.slice(0, MAX_TURN_PARTIAL_CHARS) } : {}),
      updatedAt: partial.updatedAt,
    };
  }
  return record;
}

// Atomically replace snapshots off the main event loop so readers never observe partial writes.
export async function writeTurnInflightRecord(path: string, record: TurnInflightRecord): Promise<void> {
  await writeUtf8FileAtomic(path, JSON.stringify(record));
}

export function removeTurnInflightRecord(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export interface AppendedTranscriptState {
  size: number;
  mtimeMs: number;
}

// Write a missing final newline before appending; a torn fragment must not swallow the next durable record.
export async function appendJsonlRecords(path: string, records: readonly unknown[]): Promise<AppendedTranscriptState> {
  const handle = await open(path, "a+", 0o600);
  try {
    const { size } = await handle.stat();
    let prefix = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    const payload = prefix + records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await handle.appendFile(payload, { encoding: "utf-8" });
    await handle.datasync();
    const after = await handle.stat();
    return { size: after.size, mtimeMs: after.mtimeMs };
  } finally {
    await handle.close();
  }
}

export function rowIdsOf(messages: readonly unknown[]): string[] | null {
  const ids: string[] = [];
  for (const message of messages) {
    const meta = isRecord(message) && isRecord(message.meta) ? message.meta : undefined;
    const id = meta?.messageId;
    if (typeof id !== "string" || id.length === 0) return null;
    ids.push(id);
  }
  return ids;
}

export function isIdPrefix(prefix: readonly string[], ids: readonly string[]): boolean {
  if (prefix.length > ids.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== ids[i]) return false;
  }
  return true;
}

export function sessionProgressRows(
  knownIds: readonly string[],
  ids: readonly string[],
  messages: readonly unknown[],
): unknown[] | null {
  if (isIdPrefix(knownIds, ids)) return messages.slice(knownIds.length);

  let tailStart = messages.length;
  while (tailStart > 0) {
    const result = messages[tailStart - 1];
    if (!isRecord(result) || result.role !== "tool_result") break;
    tailStart--;
  }
  const assistant = messages[tailStart - 1];
  if (!isRecord(assistant) || assistant.role !== "assistant" || !Array.isArray(assistant.toolCalls)) return null;
  // Only the active result group may grow internally; other reorders or edits require a full rewrite.
  if (knownIds.length < tailStart || !isIdPrefix(ids.slice(0, tailStart), knownIds)) return null;
  const knownTail = knownIds.slice(tailStart);
  const known = new Set(knownTail);
  const retained = ids.slice(tailStart).filter((id) => known.has(id));
  if (retained.length !== knownTail.length || !isIdPrefix(knownTail, retained)) return null;
  if (new Set(ids).size !== ids.length) return null;
  const calls = new Set(assistant.toolCalls.flatMap((call) =>
    isRecord(call) && typeof call.id === "string" ? [call.id] : []));
  const answered = new Set<string>();
  for (const result of messages.slice(tailStart)) {
    if (!isRecord(result) || typeof result.toolUseId !== "string" || !calls.has(result.toolUseId) || answered.has(result.toolUseId)) return null;
    answered.add(result.toolUseId);
  }
  return messages.slice(tailStart).filter((_message, index) => !known.has(ids[tailStart + index]));
}

export function orderToolResultRows(messages: readonly unknown[]): unknown[] {
  const ordered: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    ordered.push(message);
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
    const order = new Map(message.toolCalls.flatMap((call, index) =>
      isRecord(call) && typeof call.id === "string" ? [[call.id, index] as const] : []));
    let end = i + 1;
    while (end < messages.length) {
      const result = messages[end];
      if (!isRecord(result) || result.role !== "tool_result") break;
      end++;
    }
    const rank = (result: unknown): number => isRecord(result) && typeof result.toolUseId === "string"
      ? order.get(result.toolUseId) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    // Stable ordering preserves duplicate and unmatched rows for the pairing validator.
    ordered.push(...messages.slice(i + 1, end).sort((a, b) => rank(a) - rank(b)));
    i = end - 1;
  }
  return ordered;
}

export interface InterruptedTurnRecoveryText {
  toolResultUnknown: string;
}

// Recover deterministically so independent readers share synthesized row ids before the next save.
export function recoverInterruptedTurn(
  messages: readonly unknown[],
  record: TurnInflightRecord,
  deriveId: (seed: string) => string,
  text: InterruptedTurnRecoveryText,
): unknown[] {
  const out = [...messages];
  const ids = new Set<string>();
  for (const message of out) {
    const id = isRecord(message) && isRecord(message.meta) ? message.meta.messageId : undefined;
    if (typeof id === "string") ids.add(id);
  }
  const interruptedMeta = { interrupted: true, interruptedBy: HOST_EXIT_INTERRUPTION };

  const toolAssistantIndex = openToolTailIndex(out);
  if (toolAssistantIndex >= 0) {
    const assistant = out[toolAssistantIndex] as Record<string, unknown>;
    const completed = new Map(
      out.splice(toolAssistantIndex + 1)
        .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.toolUseId === "string")
        .map((m) => [m.toolUseId as string, m] as const),
    );
    for (const call of assistant.toolCalls as unknown[]) {
      if (!isRecord(call) || typeof call.id !== "string") continue;
      const result = completed.get(call.id);
      if (result) {
        out.push(result);
        continue;
      }
      out.push({
        role: "tool_result",
        toolUseId: call.id,
        ...(typeof call.name === "string" ? { toolName: call.name } : {}),
        content: text.toolResultUnknown,
        isError: true,
        meta: {
          messageId: deriveId(`interrupted-tool:${call.id}`),
          createdAt: record.startedAt,
          toolDisplay: { cancelled: true },
        },
      });
    }
  }

  const partial = record.partial;
  if (
    partial
    && !ids.has(partial.messageId)
    && (partial.content.trim().length > 0 || (partial.thought ?? "").trim().length > 0)
  ) {
    out.push({
      role: "assistant",
      content: partial.content,
      ...(partial.thought ? { thought: partial.thought } : {}),
      meta: { messageId: partial.messageId, createdAt: partial.updatedAt, ...interruptedMeta },
    });
  }

  const tail = out[out.length - 1];
  if (isRecord(tail) && needsInterruptionMarker(tail)) {
    out.push({
      role: "assistant",
      content: "",
      meta: { messageId: deriveId(`host-exit:${record.startedAt}`), createdAt: record.startedAt, ...interruptedMeta },
    });
  }
  return out;
}

function openToolTailIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isRecord(message)) return -1;
    if (message.role === "tool_result") continue;
    if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return i;
    return -1;
  }
  return -1;
}

// Do not synthesize interruption after a user row, existing interruption, or completed plain answer.
function needsInterruptionMarker(tail: Record<string, unknown>): boolean {
  if (tail.role === "user") return false;
  if (tail.role !== "assistant") return true;
  const meta = isRecord(tail.meta) ? tail.meta : {};
  if (meta.interrupted === true) return false;
  return Array.isArray(tail.toolCalls) && tail.toolCalls.length > 0;
}
