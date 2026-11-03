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
// A failed append never fails the memory change: it is logged and later reads of that memory report historyIncomplete.
// Known gap: a crash after the memory file is written but before its row is appended leaves no row and no mark.
// Deleting a memory scrubs the text its rows carried (title and before/after excerpts); op, actor, time and digest remain.

const log = createLogger("memory-history");

const HISTORY_FILE = "history.jsonl";
const HISTORY_STATE_FILE = "history-state.json";
const DEFAULT_MAX_HISTORY_BYTES = 5 * 1024 * 1024;
export const MAX_HISTORY_TEXT_CHARS = 2_048;

type MemoryHistoryOp = "created" | "updated" | "deleted";

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
  /** A write for this memory failed or one of its stored rows could not be read, so the list may be missing changes. */
  historyIncomplete?: true;
}

interface MemoryHistoryState {
  v: 1;
  truncatedBefore?: string;
  /** memoryId -> time of the first failed append still inside the retained window. */
  incomplete?: Record<string, string>;
}

const OPS = new Set<MemoryHistoryOp>(["created", "updated", "deleted"]);
const ACTORS = new Set<MemoryHistoryActor>(["user", "assistant", "capture", "import"]);
const SCOPES = new Set<MemoryHistoryScope>(["global", "project"]);
const ROW_OWNER = /"memoryId"\s*:\s*"([0-9A-Fa-f-]{36})"/;

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

/** The memory a stored line belongs to, recovered even from a malformed or torn line when its id survives. */
function lineOwner(line: string): string | undefined {
  return ROW_OWNER.exec(line)?.[1]?.toLowerCase();
}

/** Masked, bounded text for a title or a before/after snapshot; full bodies stay only in the memory file. */
export function historyText(text: string): string {
  const masked = maskSensitiveData(text).masked;
  return masked.length > MAX_HISTORY_TEXT_CHARS ? `${masked.slice(0, MAX_HISTORY_TEXT_CHARS - 1)}…` : masked;
}

function withoutText(row: MemoryHistoryRow): MemoryHistoryRow {
  const { before: _before, after: _after, fields, ...rest } = row;
  const { title: _title, ...keptFields } = fields ?? {};
  return { ...rest, ...(Object.keys(keptFields).length > 0 ? { fields: keptFields } : {}) };
}

export class MemoryHistory {
  private readonly path: string;
  private readonly statePath: string;
  private readonly maxBytes: number;
  private tail: Promise<unknown> = Promise.resolve();
  /** Failures whose state write also failed; kept so this process still reports them. */
  private readonly unrecordedFailures = new Map<string, string>();

  constructor(memoryDir: string, options: { maxBytes?: number } = {}) {
    this.path = join(memoryDir, HISTORY_FILE);
    this.statePath = join(memoryDir, HISTORY_STATE_FILE);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  }

  /** Serialized append; resolves after the row is durable or the failure is recorded. Never rejects. */
  record(row: Omit<MemoryHistoryRow, "v" | "at"> & { at?: string }): Promise<void> {
    const full: MemoryHistoryRow = { v: 1, at: row.at ?? new Date().toISOString(), ...withoutAt(row) };
    return this.enqueue(() => this.appendLocked(full));
  }

  /**
   * Remove the text a deleted memory's rows carry, keeping op, actor, time and digest. Rejects on failure so the
   * caller can refuse the delete rather than leave the text behind.
   */
  scrub(memoryId: string): Promise<void> {
    return this.enqueue(() => this.scrubLocked(memoryId.toLowerCase()));
  }

  async read(memoryId: string): Promise<MemoryHistoryRead> {
    await this.tail.catch(() => undefined);
    const id = memoryId.toLowerCase();
    const state = await this.readState();
    let incomplete = state.invalid || state.incomplete[id] !== undefined || this.unrecordedFailures.has(id);
    let raw = "";
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
    }
    const entries: MemoryHistoryRow[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      const row = parseHistoryRow(line);
      if (!row) {
        // A broken line marks only its own memory; a line whose owner cannot be recovered could be anyone's.
        const owner = lineOwner(line);
        if (owner === undefined || owner === id) incomplete = true;
        continue;
      }
      if (row.memoryId.toLowerCase() === id) entries.push(row);
    }
    return {
      entries,
      ...(state.truncatedBefore ? { truncatedBefore: state.truncatedBefore } : {}),
      ...(incomplete ? { historyIncomplete: true as const } : {}),
    };
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.tail.catch(() => undefined).then(job);
    this.tail = run;
    return run;
  }

  private async appendLocked(row: MemoryHistoryRow): Promise<void> {
    try {
      const { rotated } = await appendJsonlCapped(this.path, [row], this.maxBytes);
      if (rotated) await this.markRotated();
    } catch (err) {
      log.warn("memory history append failed for op=%s: %s", row.op, (err as Error).message);
      const id = row.memoryId.toLowerCase();
      try {
        const state = await this.readState();
        if (state.invalid) throw new Error("history state unreadable");
        await this.writeState({
          ...state,
          incomplete: { ...state.incomplete, [id]: state.incomplete[id] ?? row.at },
        });
      } catch (stateErr) {
        log.warn("memory history state write failed: %s", (stateErr as Error).message);
        if (!this.unrecordedFailures.has(id)) this.unrecordedFailures.set(id, row.at);
      }
    }
  }

  private async scrubLocked(id: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    let changed = false;
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      const row = parseHistoryRow(line);
      if (row) {
        if (row.memoryId.toLowerCase() === id && (row.before !== undefined || row.after !== undefined || row.fields?.title !== undefined)) {
          kept.push(JSON.stringify(withoutText(row)));
          changed = true;
        } else {
          kept.push(line);
        }
        continue;
      }
      // A malformed line that may belong to this memory cannot be scrubbed field by field, so it is dropped whole.
      const owner = lineOwner(line);
      if (owner === id || (owner === undefined && line.toLowerCase().includes(id))) {
        changed = true;
        continue;
      }
      kept.push(line);
    }
    if (changed) await writeUtf8FileAtomic(this.path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    const state = await this.readState();
    if (!state.invalid && state.incomplete[id] !== undefined) {
      const { [id]: _gone, ...incomplete } = state.incomplete;
      await this.writeState({ ...state, incomplete });
    }
    this.unrecordedFailures.delete(id);
  }

  private async markRotated(): Promise<void> {
    const raw = await readFile(this.path, "utf-8");
    const first = raw.split("\n").find((line) => line.length > 0);
    const truncatedBefore = (first ? parseHistoryRow(first)?.at : undefined) ?? new Date().toISOString();
    const state = await this.readState();
    const cutoff = Date.parse(truncatedBefore);
    // A failure older than the retained window now falls inside the reported truncation, so its mark is cleared.
    const incomplete = Object.fromEntries(
      Object.entries(state.invalid ? {} : state.incomplete).filter(([, at]) => Date.parse(at) >= cutoff),
    );
    for (const [id, at] of this.unrecordedFailures) {
      if (Date.parse(at) < cutoff) this.unrecordedFailures.delete(id);
    }
    await this.writeState({ truncatedBefore, incomplete });
  }

  private async readState(): Promise<{ truncatedBefore?: string; incomplete: Record<string, string>; invalid: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf-8");
    } catch (err) {
      return { incomplete: {}, invalid: (err as NodeJS.ErrnoException).code !== "ENOENT" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { incomplete: {}, invalid: true };
    }
    if (
      !isRecord(parsed)
      || parsed.v !== 1
      || (parsed.truncatedBefore !== undefined && !isTimestamp(parsed.truncatedBefore))
      || (parsed.incomplete !== undefined && !isRecord(parsed.incomplete))
    ) {
      return { incomplete: {}, invalid: true };
    }
    const incomplete: Record<string, string> = {};
    for (const [id, at] of Object.entries((parsed.incomplete ?? {}) as Record<string, unknown>)) {
      if (!UUID_PATTERN.test(id) || !isTimestamp(at)) return { incomplete: {}, invalid: true };
      incomplete[id.toLowerCase()] = at;
    }
    return {
      invalid: false,
      incomplete,
      ...(parsed.truncatedBefore !== undefined ? { truncatedBefore: parsed.truncatedBefore as string } : {}),
    };
  }

  private async writeState(state: { truncatedBefore?: string; incomplete: Record<string, string> }): Promise<void> {
    const next: MemoryHistoryState = {
      v: 1,
      ...(state.truncatedBefore ? { truncatedBefore: state.truncatedBefore } : {}),
      ...(Object.keys(state.incomplete).length > 0 ? { incomplete: state.incomplete } : {}),
    };
    await writeUtf8FileAtomic(this.statePath, `${JSON.stringify(next)}\n`);
  }
}

function withoutAt<T extends { at?: string }>(row: T): Omit<T, "at"> {
  const { at: _at, ...rest } = row;
  return rest;
}
