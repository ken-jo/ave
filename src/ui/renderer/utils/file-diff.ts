import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { isRecord } from "../../../shared/is-record.js";
import { buildFileDiffView, DEFAULT_FILE_DIFF_LIMITS, type FileDiffView } from "../../../shared/line-diff.js";

type FileDiffTool = "edit_file" | "multi_edit" | "write_file";

export interface FileEditHunk {
  oldText: string;
  newText: string;
}

export interface FileEditDiffData {
  path: string;
  tool: FileDiffTool;
  hunks: FileEditHunk[];
  isNewFile?: boolean;
  truncated?: boolean;
  /** Whole-file diff with real line numbers; absent when only the tool input is known. */
  view?: FileDiffView;
}

/** A tool card shows at most this many rows; the full change stays in the turn review. */
const CARD_DIFF_LIMITS = { ...DEFAULT_FILE_DIFF_LIMITS, maxRows: 400, maxCharacters: 65_536 };

/**
 * The line diff a card shows. Without a whole-file comparison each replacement is diffed on its own text,
 * so unchanged lines inside a replaced block are context and the counts are the lines that really changed.
 */
export function editDiffView(data: FileEditDiffData): FileDiffView {
  if (data.view) return data.view;
  const view: FileDiffView = { hunks: [], added: 0, removed: 0, truncated: false };
  let rows = 0;
  let characters = 0;
  for (const hunk of data.hunks) {
    const part = buildFileDiffView(hunk.oldText, hunk.newText, {
      ...CARD_DIFF_LIMITS,
      maxRows: CARD_DIFF_LIMITS.maxRows - rows,
      maxCharacters: CARD_DIFF_LIMITS.maxCharacters - characters,
    });
    view.added += part.added;
    view.removed += part.removed;
    view.truncated ||= part.truncated;
    if (part.lineEndingsOnly) view.lineEndingsOnly = true;
    for (const partHunk of part.hunks) {
      rows += partHunk.rows.length;
      for (const row of partHunk.rows) characters += row.text.length;
      view.hunks.push(partHunk);
    }
  }
  return view;
}

type ToolItem = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

export function extractFileEditDiff(tool: ToolItem): FileEditDiffData | null {
  if (tool.status !== "done") return null;
  switch (tool.name) {
    case "edit_file":
      return extractEditFile(tool);
    case "multi_edit":
      return extractMultiEdit(tool);
    case "write_file":
      return extractWriteFile(tool);
    default:
      return null;
  }
}

function extractEditFile(tool: ToolItem): FileEditDiffData | null {
  if (!isRecord(tool.input)) return null;
  const path = readResultField(tool.result, "path") ?? asString(tool.input.path);
  const oldText = asString(tool.input.oldText);
  const newText = asString(tool.input.newText);
  if (path == null || oldText == null || newText == null) return null;
  return { path, tool: "edit_file", hunks: [{ oldText, newText }] };
}

function extractMultiEdit(tool: ToolItem): FileEditDiffData | null {
  if (!isRecord(tool.input)) return null;
  const path = readResultField(tool.result, "path") ?? asString(tool.input.path);
  const reps = tool.input.replacements;
  if (path == null || !Array.isArray(reps)) return null;
  const hunks: FileEditHunk[] = [];
  for (const r of reps) {
    if (!isRecord(r)) continue;
    const o = asString(r.oldText);
    const n = asString(r.newText);
    if (o != null && n != null) hunks.push({ oldText: o, newText: n });
  }
  if (hunks.length === 0) return null;
  return { path, tool: "multi_edit", hunks };
}

function extractWriteFile(tool: ToolItem): FileEditDiffData | null {
  // Recognize ave.write_file before/after results; shapes without the sentinel fall back to raw payload rendering.
  if (typeof tool.result !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tool.result);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.kind !== "ave.write_file") return null;
  const path = asString(parsed.path);
  const after = asString(parsed.after);
  if (path == null || after == null) return null;
  const isNewFile = parsed.isNewFile === true;
  const before = asString(parsed.before) ?? "";
  const truncated = parsed.truncated === true;
  return {
    path,
    tool: "write_file",
    isNewFile,
    truncated,
    hunks: [{ oldText: isNewFile ? "" : before, newText: after }],
  };
}

function readResultField(result: string | undefined, field: string): string | null {
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    if (isRecord(parsed) && typeof parsed[field] === "string") {
      return parsed[field] as string;
    }
  } catch {
    /* result not JSON — caller falls back to input */
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
