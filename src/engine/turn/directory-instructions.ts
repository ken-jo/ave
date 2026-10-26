// Attach directory instructions on successful first touch, once while their carrier remains model-visible.
// Budget with tool output; reattach after dropping or stubbing, and defer layers that cannot fit.
import { t } from "../../i18n/index.js";
import { discoverDirectoryInstructions, type GitIgnoreVerdicts } from "../../memory/project-agents-md.js";
import { escapeHtml } from "../../shared/escape-html.js";
import { trimOversizedToolResult } from "../../shared/tool-result-trim.js";
import type { ToolSource } from "../../tools/types.js";
import type { GenericMessage } from "../llm/types.js";
import { toolResultContentReachesWire } from "../wire-serialize.js";

export const DIRECTORY_INSTRUCTIONS_SESSION_MAX_BYTES = 64 * 1024;

export interface AttachedDirectoryInstruction {
  source: string;
  bytes: number;
}

// Only files whose carrier rows still reach the model consume the live instruction budget.
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

/** Fit instruction lines within both combined result caps and byte budget; omit layers that cannot fit. */
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
  // Line-count fit is monotone, allowing a search for the largest fitting prefix.
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(cut(mid))) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? cut(low) : undefined;
}

/** Record attached files only when their new instruction block fits. */
export function directoryInstructionsForToolResult(input: {
  projectRoot: string | undefined;
  source: ToolSource | undefined;
  toolInput: unknown;
  isError: boolean;
  toolResultContent: string;
  // Artifact stubs do not carry the original result content to the model.
  stubbedOnWire: boolean;
  attached: Map<string, number>;
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
    // Stop at the first non-fitting layer to preserve root-first instruction order.
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
