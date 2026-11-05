/** Project a child's DLP-masked transcript into the board's tool steps. Only a short, one-line target label leaves this module; the
 * tool's input object, its result and any live output never do. */
import type { ChatEntry, ToolEntryItem } from "../lib/chat-stream-state.js";
import {
  WORK_BOARD_TOOL_LABEL_MAX,
  WORK_BOARD_TOOL_STEPS_MAX,
  type WorkBoardRunToolStep,
} from "../shared/work-board-types.js";

const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "file", "directory", "dir", "cwd"] as const;
const COMMAND_KEYS = ["command", "cmd", "script"] as const;
const URL_KEYS = ["url", "href", "uri"] as const;
const QUERY_KEYS = ["query", "pattern", "q"] as const;

const SHELL_NAME = /(^|[._:-])(shell|bash|cmd|powershell|terminal|exec|run)([._:-]|$)/i;
const WEB_NAME = /(browser|playwright|screenshot|chrome|open_url|web_page|web_fetch|web_search|fetch)/i;
const WRITE_NAME = /(^|[._:-])(write|edit|patch|apply|create|delete|move|rename)([._:-]|$)/i;
const READ_NAME = /(^|[._:-])(read|list|glob|grep|search|find|view|cat|ls)([._:-]|$)/i;

function kindOf(tool: ToolEntryItem): WorkBoardRunToolStep["kind"] {
  switch (tool.category) {
    case "shell":
      return "shell";
    case "write":
      return "write";
    case "read":
      return "read";
    case "network":
      return "web";
    default:
      break;
  }
  if (SHELL_NAME.test(tool.name)) return "shell";
  if (WEB_NAME.test(tool.name)) return "web";
  if (WRITE_NAME.test(tool.name)) return "write";
  if (READ_NAME.test(tool.name)) return "read";
  return "other";
}

function firstString(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!input) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** First line, whitespace collapsed, cut to the label bound with an ellipsis. */
function oneLine(text: string): string {
  const line = (text.split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length <= WORK_BOARD_TOOL_LABEL_MAX ? line : `${line.slice(0, WORK_BOARD_TOOL_LABEL_MAX - 1)}…`;
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

function hostAndPath(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return raw;
  }
}

function labelOf(tool: ToolEntryItem, kind: WorkBoardRunToolStep["kind"]): string | undefined {
  const input = tool.input;
  const command = kind === "shell" ? firstString(input, COMMAND_KEYS) : undefined;
  if (command !== undefined) return oneLine(command);
  const url = firstString(input, URL_KEYS);
  if (url !== undefined) return oneLine(hostAndPath(url));
  const path = firstString(input, PATH_KEYS);
  if (path !== undefined) return oneLine(baseName(path));
  const query = firstString(input, QUERY_KEYS);
  if (query !== undefined) return oneLine(query);
  return undefined;
}

/** The tool steps of a phase's child, each under the turn whose assistant text it followed (the first turn before any finished text). */
export function toolStepsOf(entries: readonly ChatEntry[]): WorkBoardRunToolStep[] {
  const steps: WorkBoardRunToolStep[] = [];
  let finishedTurns = 0;
  for (const entry of entries) {
    if (entry.kind === "assistant" && entry.streaming !== true) {
      finishedTurns += 1;
      continue;
    }
    if (entry.kind !== "tool_group") continue;
    for (const tool of entry.tools) {
      const kind = kindOf(tool);
      const label = labelOf(tool, kind);
      steps.push({
        toolUseId: tool.toolUseId,
        name: tool.name,
        kind,
        ...(label !== undefined && label.length > 0 ? { label } : {}),
        status: tool.status,
        turn: Math.max(1, finishedTurns),
        ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
        ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
      });
    }
  }
  return steps.length > WORK_BOARD_TOOL_STEPS_MAX ? steps.slice(steps.length - WORK_BOARD_TOOL_STEPS_MAX) : steps;
}

/** A stable key for "did anything the board shows change". */
export function toolStepsSignature(steps: readonly WorkBoardRunToolStep[]): string {
  return steps.map((s) => `${s.toolUseId}:${s.status}:${s.durationMs ?? ""}:${s.label ?? ""}`).join("|");
}
