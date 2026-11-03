import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeUtf8FileAtomic } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { maskSensitiveData } from "../shared/dlp.js";
import { isRecord } from "../shared/is-record.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { SHA256_HEX } from "../lib/hex-digest-equal.js";
import { appendJsonlCapped } from "./capped-jsonl.js";

// Append-only per-memory change history in one file; the memory store is the single writer.
// A failed append never fails the memory change: it is logged and later reads report historyIncomplete.

const log = createLogger("memory-history");

const HISTORY_FILE = "history.jsonl";
const HISTORY_STATE_FILE = "history-state.json";
const DEFAULT_MAX_HISTORY_BYTES = 5 * 1024 * 1024;
export const MAX_HISTORY_TEXT_CHARS = 2_048;

type MemoryHistoryOp =
  | "created"
  | "updated"
  | "activated"
  | "discarded"
  | "promoted"
  | "disabled"
  | "enabled"
  | "deleted";

export type MemoryHistoryActor = "user" | "assistant" | "capture" | "import";

type MemoryHistoryScope = "global" | "project";

interface MemoryHistoryFields {
  title?: string;
  contentDigest?: string;
  scope?: MemoryHistoryScope;
}

export interface MemoryHistoryRow {
  v: 1;
  memoryId: string;
  at: string;
  op: MemoryHistoryOp;
  actor: MemoryHistoryActor;
  fields?: MemoryHistoryFields;
  before?: string;
  after?: string;
}

export interface MemoryHistoryRead {
  entries: MemoryHistoryRow[];
  /** Rows older than this were rotated out of the capped file. */
  truncatedBefore?: string;
  /** A write failed or a stored row could not be read, so the list may be missing changes. */
  historyIncomplete?: true;
}

interface MemoryHistoryState {
  v: 1;
  truncatedBefore?: string;
  incompleteSince?: string;
}

const OPS = new Set<MemoryHistoryOp>(["created", "updated", "activated", "discarded", "promoted", "disabled", "enabled", "deleted"]);
const ACTORS = new Set<MemoryHistoryActor>(["user", "assistant", "capture", "import"]);
const SCOPES = new Set<MemoryHistoryScope>(["global", "project"]);

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_HISTORY_TEXT_CHARS;
}

function parseFields(value: unknown): MemoryHistoryFields | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (key !== "title" && key !== "contentDigest" && key !== "scope") return null;
  }
  if (value.title !== undefined && !isBoundedText(value.title)) return null;
  if (value.contentDigest !== undefined && !(typeof value.contentDigest === "string" && SHA256_HEX.test(value.contentDigest))) return null;
  if (value.scope !== undefined && !SCOPES.has(value.scope as MemoryHistoryScope)) return null;
  return {
    ...(value.title !== undefined ? { title: value.title as string } : {}),
    ...(value.contentDigest !== undefined ? { contentDigest: value.contentDigest as string } : {}),
    ...(value.scope !== undefined ? { scope: value.scope as MemoryHistoryScope } : {}),
  };
}

// Strict row decoding: a row that does not match the v1 shape is reported, never repaired.
function parseHistoryRow(line: string): MemoryHistoryRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  if (typeof raw.memoryId !== "string" || !UUID_PATTERN.test(raw.memoryId)) return null;
  if (!isTimestamp(raw.at) || !OPS.has(raw.op as MemoryHistoryOp) || !ACTORS.has(raw.actor as MemoryHistoryActor)) return null;
  const fields = raw.fields === undefined ? undefined : parseFields(raw.fields);
  if (fields === null) return null;
  if (raw.before !== undefined && !isBoundedText(raw.before)) return null;
  if (raw.after !== undefined && !isBoundedText(raw.after)) return null;
  return {
    v: 1,
    memoryId: raw.memoryId,
    at: raw.at,
    op: raw.op as MemoryHistoryOp,
    actor: raw.actor as MemoryHistoryActor,
    ...(fields ? { fields } : {}),
    ...(raw.before !== undefined ? { before: raw.before as string } : {}),
    ...(raw.after !== undefined ? { after: raw.after as string } : {}),
  };
}

/** Masked, bounded text for a before/after snapshot; full bodies stay only in the memory file. */
export function historyText(text: string): string {
  const masked = maskSensitiveData(text).masked;
  return masked.length > MAX_HISTORY_TEXT_CHARS ? `${masked.slice(0, MAX_HISTORY_TEXT_CHARS - 1)}…` : masked;
}

export class MemoryHistory {
  private readonly path: string;
  private readonly statePath: string;
  private readonly maxBytes: number;
  private tail: Promise<void> = Promise.resolve();
  private incompleteSince: string | undefined;

  constructor(memoryDir: string, options: { maxBytes?: number } = {}) {
    this.path = join(memoryDir, HISTORY_FILE);
    this.statePath = join(memoryDir, HISTORY_STATE_FILE);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  }

  /** Serialized append; resolves after the row is durable or the failure is recorded. Never rejects. */
  record(row: Omit<MemoryHistoryRow, "v" | "at"> & { at?: string }): Promise<void> {
    const full: MemoryHistoryRow = { v: 1, at: row.at ?? new Date().toISOString(), ...withoutAt(row) };
    const run = this.tail.then(() => this.appendLocked(full));
    this.tail = run;
    return run;
  }

  async read(memoryId: string): Promise<MemoryHistoryRead> {
    await this.tail;
    const state = await this.readState();
    let incomplete = this.incompleteSince !== undefined || state.incompleteSince !== undefined || state.invalid;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
    }
    const lines = raw.split("\n");
    // The last segment is empty after a final newline, or a torn fragment from an interrupted append.
    const tail = lines.pop();
    if (tail !== undefined && tail.length > 0) incomplete = true;
    const entries: MemoryHistoryRow[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      const row = parseHistoryRow(line);
      if (!row) {
        incomplete = true;
        continue;
      }
      if (row.memoryId === memoryId) entries.push(row);
    }
    return {
      entries,
      ...(state.truncatedBefore ? { truncatedBefore: state.truncatedBefore } : {}),
      ...(incomplete ? { historyIncomplete: true as const } : {}),
    };
  }

  private async appendLocked(row: MemoryHistoryRow): Promise<void> {
    try {
      const { rotated } = await appendJsonlCapped(this.path, [row], this.maxBytes);
      if (rotated) await this.markRotated();
    } catch (err) {
      log.warn("memory history append failed for op=%s: %s", row.op, (err as Error).message);
      this.incompleteSince ??= row.at;
      await this.writeState({ incompleteSince: this.incompleteSince }).catch((stateErr: unknown) => {
        log.warn("memory history state write failed: %s", (stateErr as Error).message);
      });
    }
  }

  private async markRotated(): Promise<void> {
    const raw = await readFile(this.path, "utf-8");
    const first = raw.split("\n").find((line) => line.length > 0);
    const oldest = first ? parseHistoryRow(first)?.at : undefined;
    await this.writeState({ truncatedBefore: oldest ?? new Date().toISOString() });
  }

  private async readState(): Promise<{ truncatedBefore?: string; incompleteSince?: string; invalid: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf-8");
    } catch (err) {
      return { invalid: (err as NodeJS.ErrnoException).code !== "ENOENT" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { invalid: true };
    }
    if (
      !isRecord(parsed)
      || parsed.v !== 1
      || (parsed.truncatedBefore !== undefined && !isTimestamp(parsed.truncatedBefore))
      || (parsed.incompleteSince !== undefined && !isTimestamp(parsed.incompleteSince))
    ) {
      return { invalid: true };
    }
    return {
      invalid: false,
      ...(parsed.truncatedBefore !== undefined ? { truncatedBefore: parsed.truncatedBefore as string } : {}),
      ...(parsed.incompleteSince !== undefined ? { incompleteSince: parsed.incompleteSince as string } : {}),
    };
  }

  private async writeState(patch: Omit<MemoryHistoryState, "v">): Promise<void> {
    const current = await this.readState();
    const next: MemoryHistoryState = {
      v: 1,
      ...(current.truncatedBefore ? { truncatedBefore: current.truncatedBefore } : {}),
      ...(current.incompleteSince ? { incompleteSince: current.incompleteSince } : {}),
      ...patch,
    };
    await writeUtf8FileAtomic(this.statePath, `${JSON.stringify(next)}\n`);
  }
}

function withoutAt<T extends { at?: string }>(row: T): Omit<T, "at"> {
  const { at: _at, ...rest } = row;
  return rest;
}
