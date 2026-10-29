import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { isUntaintedToolTrustOrigin, isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import { stagedOriginForInput } from "../../shared/staged-origins.js";
import { MCP_RESOURCE_FENCE_OPEN } from "../../shared/mcp-resource-bounds.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { RationaleEligibilityProvenance } from "../../tools/pipeline/rationale-control.js";
import type { ToolResult, ToolUseBlock } from "../../tools/executor.js";

// Derive taint from pasted and fenced resource material after replay folds attachments into text.
// Otherwise server-authored content enters the untainted reviewer and cache partition.
const INLINE_PASTED_TEXT_RE = /(^|\n)-{5} Pasted text #\d+ \(\d+ lines\) -{5}\n/;

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
  const taint = isUntaintedToolTrustOrigin(current) ? "none" : current;
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

/** The trust origin for the rest of the turn once `toolResults` return to the model. Every tool result can carry content the user did
 * not type (a file, a page, a plugin's or a sub-agent's text, a command's output, an error quoting any of these), so any result taints the
 * turn as `file-content` from then on; a turn already tainted keeps its stricter origin. Authority that needs the user's own words (a
 * command for the user's host terminal) ends with it. */
export function nextToolTrustOrigin(
  current: ToolTrustOrigin,
  toolUses: readonly ToolUseBlock[],
  toolResults: readonly ToolResult[],
): ToolTrustOrigin {
  if (!isUntaintedToolTrustOrigin(current)) return current;
  const issued = new Set(toolUses.map((toolUse) => toolUse.id));
  return toolResults.some((result) => issued.has(result.tool_use_id)) ? "file-content" : current;
}
