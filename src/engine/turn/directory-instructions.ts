/**
 * Directory instructions attached on first touch.
 *
 * The launch prompt carries the project's instruction chain down to the
 * project root. A subdirectory can hold its own `AGENTS.md` (or `CLAUDE.md`)
 * for work inside it; loading every one at launch would spend context on
 * directories the session never visits. Instead, when a builtin tool succeeds
 * on a `path` below the project root, the instruction files between the root
 * and that path are appended to the tool's result, framed as project-provided
 * text, like the launch layer.
 *
 * Attached once while visible. The tool_result row records which files it
 * carries (`meta.directoryInstructions`). A file counts as attached only while
 * such a row still reaches the provider: once compaction drops the row or
 * stubs its content, the next touch attaches the file again.
 *
 * Budgets. The appended text is part of the tool result and is measured with
 * it: a layer is cut by lines so the whole result stays within the per-result
 * cap (`MAX_TOOL_RESULT_LINES` / `MAX_TOOL_RESULT_TOKENS`), because an
 * over-cap result is replaced by a head/tail stub on the wire and would lose
 * both the tool's output and the instructions. A layer that cannot fit at all
 * waits for a later touch. Across the session, the attached blocks still in
 * context share {@link DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES}.
 */
import { t } from "../../i18n/index.js";
import { discoverDirectoryInstructions, type GitIgnoreVerdicts } from "../../memory/project-agents-md.js";
import { escapeHtml } from "../../shared/escape-html.js";
import { trimOversizedToolResult } from "../../shared/tool-result-trim.js";
import type { ToolSource } from "../../tools/types.js";
import type { GenericMessage } from "../llm/types.js";
import { toolResultContentReachesWire } from "../wire-serialize.js";

/** Bytes of first-touch instruction blocks the session's live context may hold at once. */
export const DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES = 64 * 1024;

/** One attached file: its project-relative path and the bytes its block added. */
export interface AttachedDirectoryInstruction {
  source: string;
  bytes: number;
}

/**
 * The files attached by rows that still reach the provider, with the bytes
 * each one's block occupies.
 */
export function liveDirectoryInstructions(messages: readonly GenericMessage[]): Map<string, number> {
  const live = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "tool_result") continue;
    const attached = message.meta?.directoryInstructions;
    if (!attached || !toolResultContentReachesWire(message.meta)) continue;
    for (const entry of attached) live.set(entry.source, entry.bytes);
  }
  return live;
}

function frame(source: string, content: string, truncated: boolean, cutForResult: boolean): string {
  return [
    `<ave-project-agents-context source="${escapeHtml(source)}" trust="project-provided">`,
    t("be_systemPromptBuilder.directoryAgentsContextIntro", { path: source }),
    t("be_systemPromptBuilder.projectAgentsContextProvenance"),
    "",
    content,
    ...(cutForResult
      ? ["", t("be_systemPromptBuilder.directoryAgentsContextCut", { path: source })]
      : truncated ? ["", t("be_systemPromptBuilder.projectAgentsContextTruncated")] : []),
    "</ave-project-agents-context>",
  ].join("\n");
}

/**
 * The largest block for this layer that keeps `base` plus the block within
 * the per-result cap and `maxBytes`, or `undefined` when not even its first
 * line fits.
 */
function fitLayer(
  base: string,
  layer: { relativePath: string; content: string; truncated: boolean },
  maxBytes: number,
): string | undefined {
  const fits = (block: string): boolean =>
    Buffer.byteLength(block, "utf-8") <= maxBytes
    && trimOversizedToolResult(`${base}\n\n${block}`).truncated === undefined;
  const whole = frame(layer.relativePath, layer.content, layer.truncated, false);
  if (fits(whole)) return whole;
  const lines = layer.content.split("\n");
  const cut = (count: number): string =>
    frame(layer.relativePath, lines.slice(0, count).join("\n"), true, true);
  // Fitting is monotone in the number of lines kept: find the most that fit.
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(cut(mid))) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? cut(low) : undefined;
}

/**
 * The instruction block to append to one tool result, with the files it
 * carries, or `undefined` when nothing new applies or fits. Records each
 * attached file in `attached`.
 */
export function directoryInstructionsForToolResult(input: {
  projectRoot: string | undefined;
  source: ToolSource | undefined;
  toolInput: unknown;
  isError: boolean;
  /** The tool's own output: the appended text is budgeted together with it. */
  toolResultContent: string;
  /** Set when the result's content will not reach the provider as is (an output artifact stub). */
  stubbedOnWire: boolean;
  /** Files attached by rows still in context, with their block sizes (see {@link liveDirectoryInstructions}). */
  attached: Map<string, number>;
  /** The session's memo of git ignore verdicts (see `discoverDirectoryInstructions`). */
  gitIgnoreVerdicts?: GitIgnoreVerdicts;
}): { text: string; attached: AttachedDirectoryInstruction[] } | undefined {
  const { projectRoot, source, toolInput, isError, toolResultContent, stubbedOnWire, attached, gitIgnoreVerdicts } = input;
  if (!projectRoot || source !== "builtin" || isError || stubbedOnWire) return undefined;
  const path = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>).path
    : undefined;
  if (typeof path !== "string" || path.length === 0) return undefined;
  const layers = discoverDirectoryInstructions(projectRoot, path, attached, gitIgnoreVerdicts ? { gitIgnoreVerdicts } : {});
  if (layers.length === 0) return undefined;
  let sessionBytes = [...attached.values()].reduce((sum, bytes) => sum + bytes, 0);
  let combined = toolResultContent;
  const blocks: string[] = [];
  const records: AttachedDirectoryInstruction[] = [];
  for (const layer of layers) {
    const block = fitLayer(combined, layer, DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES - sessionBytes);
    // Stop at the first that does not fit, so what lands keeps root-first order.
    if (block === undefined) break;
    const bytes = Buffer.byteLength(block, "utf-8");
    combined = `${combined}\n\n${block}`;
    sessionBytes += bytes;
    blocks.push(block);
    records.push({ source: layer.relativePath, bytes });
    attached.set(layer.relativePath, bytes);
  }
  return blocks.length > 0 ? { text: blocks.join("\n\n"), attached: records } : undefined;
}
