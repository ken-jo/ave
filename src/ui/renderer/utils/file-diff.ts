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
  /** Size of the written file, from the tool result. */
  bytes?: number;
  /** True when the host stored a whole-file line diff for this call. */
  hasSidecar?: boolean;
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
  const result = parseResult(tool.result);
  const path = asString(result?.path) ?? asString(tool.input.path);
  const oldText = asString(tool.input.oldText);
  const newText = asString(tool.input.newText);
  if (path == null || oldText == null || newText == null) return null;
  return { path, tool: "edit_file", hunks: [{ oldText, newText }], hasSidecar: result?.hasSidecar === true };
}

function extractMultiEdit(tool: ToolItem): FileEditDiffData | null {
  if (!isRecord(tool.input)) return null;
  const result = parseResult(tool.result);
  const path = asString(result?.path) ?? asString(tool.input.path);
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
  return { path, tool: "multi_edit", hunks, hasSidecar: result?.hasSidecar === true };
}

/**
 * write_file reports `{ path, bytes, isNewFile?, hasSidecar? }`. The content is not in the result:
 * the card loads the host's line diff, and a created file can be shown from the tool input alone.
 */
function extractWriteFile(tool: ToolItem): FileEditDiffData | null {
  const result = parseResult(tool.result);
  const path = asString(result?.path);
  if (result == null || path == null || typeof result.bytes !== "number") return null;
  const isNewFile = result.isNewFile === true;
  const content = isRecord(tool.input) ? asString(tool.input.content) : null;
  return {
    path,
    tool: "write_file",
    isNewFile,
    bytes: result.bytes,
    hasSidecar: result.hasSidecar === true,
    // Without the earlier content an overwrite has no honest diff; only a created file is all additions.
    hunks: isNewFile && content != null ? [{ oldText: "", newText: content }] : [],
  };
}

function parseResult(result: string | undefined): Record<string, unknown> | null {
  if (typeof result !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A non-JSON result (an error string, a compaction stub) carries no diff fields.
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
