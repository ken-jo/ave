import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import { stagedOriginForInput } from "../../shared/staged-origins.js";
import { MCP_RESOURCE_FENCE_OPEN } from "../../shared/mcp-resource-bounds.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { RationaleEligibilityProvenance } from "../../tools/pipeline/rationale-control.js";
import type { ToolResult, ToolUseBlock } from "../../tools/executor.js";

// Derive taint from pasted and fenced resource material after replay folds attachments into text.
// Otherwise server-authored content enters the untainted reviewer and cache partition.
const INLINE_PASTED_TEXT_RE = /(^|\n)-{5} Pasted text #\d+ \(\d+ lines\) -{5}\n/;

const FILE_CONTENT_RESULT_TOOLS = new Set([
  "read_file",
  "grep_files",
]);

export function initialToolTrustOrigin(inputOrigin: ChatInputOrigin, turnInput: string): ToolTrustOrigin {
  if (
    inputOrigin === "file-content"
    || INLINE_PASTED_TEXT_RE.test(turnInput)
    || turnInput.includes(MCP_RESOURCE_FENCE_OPEN)
  ) {
    return "file-content";
  }
  if (inputOrigin === "agent-message") {
    return "agent-message";
  }
  // Preserve staged-origin provenance through tools; it never becomes keyboard-authored input.
  if (inputOrigin === "surface-user" || inputOrigin === "tailnet-surface" || inputOrigin === "platform-bridge") {
    return inputOrigin;
  }
  // Resolve registered origins centrally so newly added kinds cannot default to untainted arguments.
  if (stagedOriginForInput(inputOrigin)) {
    return inputOrigin as ToolTrustOrigin;
  }
  return "llm-tool-arg";
}

export function rationaleProvenanceFor(
  startedFromUserKeyboard: boolean,
  current: ToolTrustOrigin,
): RationaleEligibilityProvenance {
  const taint = current === "llm-tool-arg" || current === "user-keyboard"
    ? "none"
    : current;
  return { startedFromUserKeyboard, taint };
}

export function summarizePermissionUserIntent(
  inputOrigin: ChatInputOrigin,
  turnInput: string,
): string | undefined {
  if (!isUserKeyboardOrigin(inputOrigin) && inputOrigin !== "queue-auto") {
    return undefined;
  }
  const cleaned = turnInput
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.startsWith("/")) return undefined;
  return cleaned.length > 500 ? `${cleaned.slice(0, 499)}…` : cleaned;
}

export function nextToolTrustOrigin(
  current: ToolTrustOrigin,
  toolUses: readonly ToolUseBlock[],
  toolResults: readonly ToolResult[],
): ToolTrustOrigin {
  if (current === "file-content" || current === "agent-message") return current;
  const successful = new Set(
    toolResults
      .filter((result) => !result.is_error)
      .map((result) => result.tool_use_id),
  );
  return toolUses.some((toolUse) => successful.has(toolUse.id) && FILE_CONTENT_RESULT_TOOLS.has(toolUse.name))
    ? "file-content"
    : current;
}
