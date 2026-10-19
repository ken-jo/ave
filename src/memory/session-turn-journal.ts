/**
 * Crash-durable progress for the turn that is running right now.
 *
 * A session transcript (`sessions/<id>.jsonl`) used to be written only by a
 * whole-file rewrite at the turn's persistence points, all of which sit after
 * the model loop returns. A process that quit, crashed, or was killed in the
 * middle of a turn therefore lost every round that turn had streamed. Two
 * records close that window, and this module owns their on-disk shape:
 *
 * 1. Completed rows (an assistant round, a tool_result) are APPENDED to the
 *    transcript as soon as they enter history — one JSON line each, the same
 *    line format the rewrite produces, so every existing reader keeps working.
 *    A later rewrite from history replaces them byte-for-byte by row id, which
 *    is what makes the turn's normal completion idempotent.
 * 2. The text still streaming for the current round lives in a small sidecar,
 *    `sessions/<id>/turn-inflight.json`, replaced atomically at most once
 *    per throttle interval. Its presence is also the proof that a turn was in
 *    flight: the engine deletes it after a successful transcript sync at turn
 *    end. An orphaned sidecar means the turn died or could not save its tail.
 *
 * Load folds the sidecar back in (`recoverInterruptedTurn`): the partial text
 * becomes an interrupted assistant row, a tool call that never got a result
 * gets an "interrupted, result unknown" result instead of being silently
 * dropped, and the tail is marked so the renderer can offer Continue. Nothing
 * is ever re-run automatically.
 *
 * Reference hosts do the same thing at different grain: Claude Code writes
 * each message, tool use and result to a plaintext JSONL as it works; Codex's
 * rollout recorder appends one line per item and newline-terminates a torn
 * tail before appending again (`ensure_rollout_is_newline_terminated`);
 * opencode persists each part's start and end durably while its text deltas
 * stay ephemeral. Ave goes one step further than opencode on the delta side,
 * because on a desktop app a crash mid-answer is exactly what users see.
 */
import { unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { writeUtf8FileAtomic } from "../lib/atomic-file.js";
import { isRecord } from "../shared/is-record.js";

const TURN_INFLIGHT_FILE = "turn-inflight.json";

/** `meta.interruptedBy` value for a turn cut short by the app exiting. */
export const HOST_EXIT_INTERRUPTION = "host-exit" as const;

/** Upper bound on the sidecar's partial text, so a runaway stream cannot make each snapshot unbounded. */
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

/**
 * Read a sidecar written by {@link writeTurnInflightRecord}. The file sits in a
 * user-writable directory, so anything that does not have exactly the shape
 * written here is ignored rather than trusted.
 */
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

/**
 * Replace the sidecar through the host's atomic writer (temp + fsync +
 * rename), so a reader sees either the previous snapshot or the new one, never
 * half of one. Async: written at most once per throttle interval while text
 * streams, and the disk wait stays off the main process's event loop.
 */
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

/**
 * Append records to a JSONL file as whole lines and make them durable.
 *
 * A previous process may have died halfway through a line. Appending straight
 * after it would fuse the torn fragment with the next record into one
 * unparseable line and lose that record too, so a missing final newline is
 * written first (the same repair Codex's rollout recorder makes on reopen).
 * The torn fragment itself is skipped by the reader as a malformed line.
 *
 * All records go out in one write and one fdatasync: a completed round is a
 * unit the user would be upset to lose to a power cut, and rounds arrive
 * seconds apart, so the sync is paid per round rather than per token.
 */
export async function appendJsonlRecords(path: string, records: readonly unknown[]): Promise<AppendedTranscriptState> {
  // Async so the fdatasync — the expensive part — waits on the libuv pool, not
  // on the main process's event loop that is delivering stream frames.
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

/** Row ids of a history snapshot, or null when any row has none (then only a rewrite is safe). */
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

export interface InterruptedTurnRecoveryText {
  /** Content of the result recorded for a tool call that never returned. */
  toolResultUnknown: string;
}

/**
 * Fold an orphaned in-flight sidecar into the transcript read from disk.
 *
 * Pure and deterministic: every synthesized row's id comes from `deriveId`, so
 * two independent reads of the same files (the sidebar's history read and the
 * conversation loop's resume) agree, and the next whole-file save persists the
 * same rows the user was shown.
 *
 * - An open tool tail (the last assistant row with tool calls, followed only
 *   by tool results) gets a result for every call that has none: an error
 *   result saying the outcome is unknown, flagged `toolDisplay.cancelled` so
 *   the row renders as a halt. This keeps the call visible and the provider's
 *   call/result pairing valid without running anything again.
 * - A partial whose round never committed becomes an interrupted assistant row
 *   under the id the committed row would have had.
 * - If the transcript then ends in neither the user's message nor a finished
 *   answer, an empty interrupted row marks where the turn stopped.
 */
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

/**
 * Whether the recovered tail still needs a row saying the turn stopped here.
 * Not after the user's own message (nothing was produced: Continue re-asks it),
 * not after an interrupted row, and not after a plain answer — a turn whose
 * last row is a finished answer died after it was complete.
 */
function needsInterruptionMarker(tail: Record<string, unknown>): boolean {
  if (tail.role === "user") return false;
  if (tail.role !== "assistant") return true;
  const meta = isRecord(tail.meta) ? tail.meta : {};
  if (meta.interrupted === true) return false;
  return Array.isArray(tail.toolCalls) && tail.toolCalls.length > 0;
}
