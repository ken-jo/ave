import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { GenericMessage } from "./llm/types.js";
import { userContentText } from "./llm/types.js";
import { estimateMessageTokensForWire, estimateMessagesTokens, estimateTokens } from "./auto-compact.js";
import { aveHome } from "../shared/ave-home.js";
import { createLogger } from "../lib/logger.js";
import {
  CompressionStatus,
  TRUNCATION_THRESHOLD_TOKENS,
  TRUNCATION_PRESERVED_LINES,
} from "../shared/compact-status.js";
import { t } from "../i18n/index.js";
import { neutralizeFenceClose } from "../shared/fence-sanitizer.js";

const log = createLogger("compact");

export const SUMMARY_TEMPLATE_HEADERS_V1 = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Relevant Files",
  "Next Steps",
  "Critical Context",
  "Current Plan",
  "Verification State",
  "Open Blockers",
  "Unsafe Pending Actions",
  "Last Tool Boundary",
] as const;

type SummarySectionName = (typeof SUMMARY_TEMPLATE_HEADERS_V1)[number];

export interface ParsedCompactSummary {
  templateVersion: 1;
  sections: Partial<Record<SummarySectionName, string>>;

  raw?: string;
}

export interface CompactBoundary {
  templateVersion: 1;

  vendorOpaqueState?: VendorOpaqueState;
  structuredSummary: ParsedCompactSummary;
  recentVerbatim: GenericMessage[];
  pinnedArtifacts: string[];
  toolBoundaryLedger: ToolCallSummary[];

  createdAt: string;

  compactNum: number;
}

type VendorOpaqueState =
  | { vendor: "openai"; openaiCompactionItem: OpenAICompactionItem }

  ;

interface OpenAICompactionItem {
  type: "compaction";
  encrypted_content: string;

  [k: string]: unknown;
}

interface ToolCallSummary {
  round: number;
  toolName: string;

  resultSummary: string;
  isError?: boolean;
}

export const SUMMARY_TEMPLATE_PROMPT_V1: string = t("be_structuredCompact.summaryTemplatePrompt");

export function parseSummary(text: string): ParsedCompactSummary {
  const sections: Partial<Record<SummarySectionName, string>> = {};

  const validHeaders = new Set<string>(SUMMARY_TEMPLATE_HEADERS_V1);
  const lines = text.split("\n");
  let currentHeader: SummarySectionName | null = null;
  let currentBody: string[] = [];

  const flushCurrent = (): void => {
    if (currentHeader === null) return;
    const body = currentBody.join("\n").trim();
    if (body.length > 0) {
      sections[currentHeader] = body;
    }
  };

  for (const line of lines) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      flushCurrent();
      const headerText = headerMatch[1];
      currentHeader = validHeaders.has(headerText) ? (headerText as SummarySectionName) : null;
      currentBody = [];
    } else if (currentHeader !== null) {
      currentBody.push(line);
    }
  }
  flushCurrent();

  const allPresent = SUMMARY_TEMPLATE_HEADERS_V1.every((h) => sections[h] !== undefined);
  if (!allPresent) {
    return {
      templateVersion: 1,
      sections,
      raw: text,
    };
  }

  return {
    templateVersion: 1,
    sections,
  };
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}

export function freezeBoundary(boundary: CompactBoundary): Readonly<CompactBoundary> {
  deepFreeze(boundary);
  return boundary;
}

/** Keep summaries in history so compaction preserves the cached system prefix.
 * Fence prior content as context; only messages outside that fence may direct action. */
function renderCompactSummaryMessage(compactNum: number, summary: string): string {
  return [
    t("be_structuredCompact.boundaryStub", { n: String(compactNum) }),
    "",
    t("be_structuredCompact.summaryMessageUseContext"),
    "",
    t("be_structuredCompact.summaryMessageSecurityGuard"),
    "",
    "<prior-context-summary>",
    neutralizeFenceClose(summary, "prior-context-summary"),
    "</prior-context-summary>",
  ].join("\n");
}

/** Migrate metadata-only summaries into their existing boundary row without rewriting populated rows. */
function withCompactSummaryInLatestBoundary(
  messages: GenericMessage[],
  summary: string | undefined,
): GenericMessage[] {
  if (summary === undefined || summary.length === 0) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]!;
    if (row.role !== "user" || row.meta?.compactBoundary !== true) continue;
    if (typeof row.content !== "string" || row.content.includes("<prior-context-summary>")) return messages;
    const out = messages.slice();
    out[i] = { ...row, content: renderCompactSummaryMessage(row.meta.compactNum ?? 0, summary) };
    return out;
  }
  return messages;
}

/** Ensure forked or legacy history carries its summary in one boundary row; repeated application is inert. */
export function withSummaryBoundary(
  messages: GenericMessage[],
  source: { compactNum: number; summary: string | undefined; trigger?: "auto-compact" | "manual"; createdAt?: string },
): GenericMessage[] {
  const summary = source.summary;
  if (summary === undefined || summary.length === 0) return messages;
  if (messages.some((m) => m.role === "user" && m.meta?.compactBoundary === true)) {
    return withCompactSummaryInLatestBoundary(messages, summary);
  }
  const createdAt = source.createdAt === undefined ? Number.NaN : new Date(source.createdAt).getTime();
  const boundaryRow: GenericMessage = {
    role: "user",
    content: renderCompactSummaryMessage(source.compactNum, summary),
    meta: {
      compactBoundary: true,
      compactNum: source.compactNum,
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      checkpointMeta: {
        removedMessages: 0,
        freedTokens: 0,
        compactNum: source.compactNum,
        ...(source.trigger !== undefined ? { trigger: source.trigger } : {}),
        summary: summary.slice(0, 200),
      },
    },
  };
  return [boundaryRow, ...messages];
}

const MAX_PARSE_RETRY = 1;

// Bound user-supplied compact focus as a phrase rather than a document.
const MAX_COMPACT_FOCUS_CHARS = 2_000;

const TOOL_BOUNDARY_LEDGER_K = 5;

const LEDGER_RESULT_MAX = 200;

export const DEFAULT_PRESERVE_RECENT_TURNS = 5;

type PreserveUnit = "user-turns" | "tool-rounds";

// Recap generation must use the common no-tool reviewer capability, never a direct transport.
export interface CompactRecapReviewer {
  review(
    task: "recap",
    prompt: string,
    options?: {
      systemPrompt?: string;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

export interface CompactWithBoundaryArgs {
  messages: GenericMessage[];
  memoryReviewer: CompactRecapReviewer;

  preserveRecentTokens: number;
  // Preserve the pending question in addition to the configured completed-user-turn floor.
  preserveRecentTurns?: number;
  /** Use user-turn floors between turns and tool-round floors inside active turns.
   * A user-turn floor inside a tool loop protects the whole turn and prevents reduction. */
  preserveUnit?: PreserveUnit;
  compactNum: number;

  sessionId: string;

  preflightTokens: number;
  /** The summarizer's input ceiling may be smaller than the chat model's trigger threshold. */
  summaryInputTokens?: number;
  abortSignal?: AbortSignal;
  // Fence compact focus as data; it cannot change which messages are selected.
  focus?: string;
}

export interface CompactWithBoundaryResult {
  status: CompressionStatus;

  boundary: Readonly<CompactBoundary> | null;
  newHistory: GenericMessage[];

  removedCount: number;

  estimatedAfter: number;

  truncatedDir?: string;

  truncatedCount: number;
}

async function truncateOversizeMessages(
  messages: GenericMessage[],
  sessionId: string,
  compactNum: number,
): Promise<{ messages: GenericMessage[]; truncatedCount: number; truncatedDir: string }> {
  const truncatedDir = path.join(aveHome(), "sessions", sessionId, "truncated");
  let truncatedCount = 0;
  const result: GenericMessage[] = [];
  let dirCreated = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateMessageTokensForWire(msg);
    if (msgTokens <= TRUNCATION_THRESHOLD_TOKENS) {
      result.push(msg);
      continue;
    }

    if (!dirCreated) {
      await fs.mkdir(truncatedDir, { recursive: true, mode: 0o700 });
      dirCreated = true;
    }

    const uuid = randomUUID();
    const fileName = `compact-${compactNum}-msg-${i}-${Date.now()}-${uuid}.txt`;
    const filePath = path.join(truncatedDir, fileName);
    const fullText = extractMessageText(msg);
    await fs.writeFile(filePath, fullText, { mode: 0o600 });

    const lines = fullText.split("\n");
    const preservedLines = lines.slice(-TRUNCATION_PRESERVED_LINES);
    const clippedText = [
      `[…earlier ${lines.length - preservedLines.length} lines truncated, full content saved to ${filePath}]`,
      ...preservedLines,
    ].join("\n");

    result.push(rebuildMessageWithText(msg, clippedText));
    truncatedCount++;
  }

  return { messages: result, truncatedCount, truncatedDir };
}

function extractMessageText(msg: GenericMessage): string {
  if (msg.role === "user") return userContentText(msg.content);
  if (msg.role === "assistant") {
    const tool = msg.toolCalls && msg.toolCalls.length > 0
      ? `\n[tool calls: ${msg.toolCalls.map((t) => t.name).join(", ")}]`
      : "";
    return `${msg.content}${tool}`;
  }
  // Archive tool names and error state so results remain understandable without assistant call metadata.
  const provenance = `[tool_result: tool=${msg.toolName ?? "?"}${msg.isError ? " error" : ""}]\n`;
  return `${provenance}${msg.content}`;
}

function rebuildMessageWithText(msg: GenericMessage, newText: string): GenericMessage {
  if (msg.role === "user") {
    return { ...msg, content: newText };
  }
  if (msg.role === "assistant") {
    return { ...msg, content: newText };
  }
  return { ...msg, content: newText };
}

/** Archive budget and forced-drop slices for recovery; return their path for the compact notice. */
async function archiveDroppedMessages(
  messages: GenericMessage[],
  sessionId: string,
  compactNum: number,
  label: "precompact-drop" | "forced-drop",
): Promise<string> {
  if (messages.length === 0) return "";
  const truncatedDir = path.join(aveHome(), "sessions", sessionId, "truncated");
  await fs.mkdir(truncatedDir, { recursive: true, mode: 0o700 });
  const uuid = randomUUID();
  const fileName = `compact-${compactNum}-${label}-${Date.now()}-${uuid}.json`;
  const filePath = path.join(truncatedDir, fileName);
  await fs.writeFile(filePath, JSON.stringify(messages, null, 2), { mode: 0o600 });
  return truncatedDir;
}

/** Archive oldest messages until their combined input fits; per-message limits cannot bound their sum. */
async function dropOldestUntilUnderBudget(
  toCompact: GenericMessage[],
  budget: number,
  sessionId: string,
  compactNum: number,
  clipSingleton = false,
): Promise<{ messages: GenericMessage[]; droppedCount: number; clippedCount: number; truncatedDir: string }> {
  if (budget <= 0 || toCompact.length === 0) {
    return { messages: toCompact, droppedCount: 0, clippedCount: 0, truncatedDir: "" };
  }
  // Maintain a running token total to avoid quadratic serialization while compaction holds its lock.
  const perMessageTokens = toCompact.map((message) => estimateMessageTokensForWire(message));
  let currentTotal = perMessageTokens.reduce((a, b) => a + b, 0);
  if (currentTotal <= budget) {
    return { messages: toCompact, droppedCount: 0, clippedCount: 0, truncatedDir: "" };
  }
  const dropped: GenericMessage[] = [];
  const surviving = [...toCompact];
  // Token cursor order must stay aligned with oldest-first message removal.
  let cursor = 0;
  // Keep one summarizable message; the per-message pre-pass already clips an oversized singleton.
  while (currentTotal > budget && surviving.length > 1) {
    const oldest = surviving.shift();
    if (oldest === undefined) break;
    dropped.push(oldest);
    currentTotal -= perMessageTokens[cursor];
    cursor += 1;
  }
  const droppedCount = dropped.length;
  let clippedCount = 0;
  if (clipSingleton && currentTotal > budget && surviving[0]) {
    const last = surviving[0];
    dropped.push(last);
    // Three UTF-16 units per estimated token is conservative for both supported estimator weights; reserve the archive marker.
    const maxChars = Math.max(0, Math.floor((budget - 64) * 3));
    const tail = maxChars > 0 ? extractMessageText(last).slice(-maxChars) : "";
    surviving[0] = rebuildMessageWithText(last, `[earlier content archived]\n${tail}`);
    clippedCount = 1;
  }
  const truncatedDir = await archiveDroppedMessages(dropped, sessionId, compactNum, "precompact-drop");
  return { messages: surviving, droppedCount, clippedCount, truncatedDir };
}

/** Preserve safe recent boundaries, summarize through the reviewer, and freeze the resulting checkpoint.
 * The returned history carries its summary, so restoring it applies the whole result. */
export async function compactWithBoundary(
  args: CompactWithBoundaryArgs,
): Promise<CompactWithBoundaryResult> {
  const {
    messages,
    memoryReviewer,
    preserveRecentTokens,
    preserveRecentTurns = DEFAULT_PRESERVE_RECENT_TURNS,
    preserveUnit = "user-turns",
    compactNum,
    sessionId,
    preflightTokens,
    abortSignal,
    focus,
    summaryInputTokens,
  } = args;

  const { messages: workingMessages, truncatedCount, truncatedDir: perMessageTruncDir } =
    await truncateOversizeMessages(messages, sessionId, compactNum);

  const { toCompact, toPreserve, protectedPreserveCount } = splitForBoundary(
    workingMessages,
    preserveRecentTokens,
    preserveRecentTurns,
    preserveUnit,
  );

  if (toCompact.length === 0) {
    if (truncatedCount > 0) {
      const estimatedAfter = estimateMessagesTokens(workingMessages);
      log.info(`compact: status=content_truncated truncated=${truncatedCount} estimatedAfter=${estimatedAfter} compactNum=${compactNum}`);
      return {
        status: CompressionStatus.CONTENT_TRUNCATED,
        boundary: null,
        newHistory: workingMessages,
        removedCount: truncatedCount,
        estimatedAfter,
        truncatedDir: perMessageTruncDir,
        truncatedCount,
      };
    }
    const noopEstimatedAfter = estimateMessagesTokens(messages);
    log.info(`compact: status=noop estimatedAfter=${noopEstimatedAfter} compactNum=${compactNum}`);
    return {
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: messages,
      removedCount: 0,
      estimatedAfter: noopEstimatedAfter,
      truncatedCount: 0,
    };
  }

  // Archive excess combined input before summary generation, even when each message fits individually.
  const summaryBudget = summaryInputTokens !== undefined && summaryInputTokens > 0
    ? Math.floor(summaryInputTokens * 0.9) - estimateTokens(SUMMARY_TEMPLATE_PROMPT_V1) - estimateTokens(focus ?? "")
    : Infinity;
  const llmInputBudget = Math.max(1, Math.min(preflightTokens > 0 ? Math.floor(preflightTokens * 0.9) : Infinity, summaryBudget));
  const reverseBudgetResult = await dropOldestUntilUnderBudget(
    toCompact,
    llmInputBudget,
    sessionId,
    compactNum,
    summaryInputTokens !== undefined,
  );
  const finalToCompact = reverseBudgetResult.messages;
  const reverseBudgetDir = reverseBudgetResult.truncatedDir;
  const totalTruncatedCount = truncatedCount + reverseBudgetResult.droppedCount + reverseBudgetResult.clippedCount;

  const conversationText = renderConversation(finalToCompact);
  let summary: ParsedCompactSummary | null = null;
  let lastRawText = "";
  for (let attempt = 0; attempt <= MAX_PARSE_RETRY; attempt++) {
    const text = await callSummaryLLM({
      memoryReviewer,
      conversationText,
      compactNum,
      abortSignal,
      ...(focus !== undefined ? { focus } : {}),
      ...(summaryInputTokens !== undefined ? { summaryInputTokens } : {}),
    });
    lastRawText = text;
    const parsed = parseSummary(text);
    if (!parsed.raw) {
      summary = parsed;
      break;
    }
  }
  if (!summary) {
    summary = { templateVersion: 1, sections: {}, raw: lastRawText };
  }

  // Derive pinned artifacts and tool ledger from the post-archive messages actually summarized.
  const pinnedArtifacts = collectPinned(finalToCompact);
  const toolBoundaryLedger = makeToolLedger(finalToCompact, TOOL_BOUNDARY_LEDGER_K);

  const boundary = freezeBoundary({
    templateVersion: 1,
    structuredSummary: summary,
    recentVerbatim: toPreserve,
    pinnedArtifacts,
    toolBoundaryLedger,
    createdAt: new Date().toISOString(),
    compactNum,
  });

  // Persist checkpoint metadata so reload renders a divider rather than a raw user bubble.
  // Use the same pre/post token delta as the live compact notice.
  const boundaryContent = renderCompactSummaryMessage(compactNum, renderBoundaryAsPreamble(boundary));
  const stubEstimatedAfter = estimateMessagesTokens([
    { role: "user" as const, content: boundaryContent },
  ]);
  const stubFreedTokens = Math.max(
    0,
    estimateMessagesTokens(finalToCompact) - stubEstimatedAfter,
  );
  const stubRemovedMessages = finalToCompact.length + reverseBudgetResult.droppedCount;
  const boundaryCreatedAtMs = new Date(boundary.createdAt).getTime();
  const stubMessage: GenericMessage = {
    role: "user",
    content: boundaryContent,
    meta: {
      compactBoundary: true,
      compactNum,
      removedCount: stubRemovedMessages,
      compactedAt: boundary.createdAt,
      boundary,
      createdAt: boundaryCreatedAtMs,
      checkpointMeta: {
        removedMessages: stubRemovedMessages,
        freedTokens: stubFreedTokens,
        compactNum,
        trigger: "auto-compact",
        ...(summary.raw ? { summary: summary.raw.slice(0, 200) } : {}),
      },
    },
  };
  let newHistory: GenericMessage[] = [stubMessage, ...toPreserve];
  let estimatedAfter = estimateMessagesTokens(newHistory);

  // If summarized history still exceeds budget, archive an older preserve slice while protecting recent turns.
  const forcedDropCap = Math.max(0, toPreserve.length - protectedPreserveCount);
  if (preflightTokens > 0 && estimatedAfter > preflightTokens * 0.8 && forcedDropCap > 0) {
    const rawDropCount = Math.min(Math.ceil(toPreserve.length / 2), forcedDropCap);
    // Advance past orphan tool results or the next provider request will fail pair validation.
    const boundarySafeDropCount = adjustForwardToToolBoundary(toPreserve, rawDropCount);
    const protectedSafeDropCount = boundarySafeDropCount <= forcedDropCap ? boundarySafeDropCount : 0;
    const dropCount = clampDropBeforeLatestRenderableUser(toPreserve, protectedSafeDropCount);
    if (dropCount > 0) {
      const droppedSlice = toPreserve.slice(0, dropCount);
      const survivingPreserve = toPreserve.slice(dropCount);
      const forcedArchiveDir = await archiveDroppedMessages(
        droppedSlice,
        sessionId,
        compactNum,
        "forced-drop",
      );
      newHistory = [stubMessage, ...survivingPreserve];
      estimatedAfter = estimateMessagesTokens(newHistory);
      const finalTruncDir = forcedArchiveDir || reverseBudgetDir || perMessageTruncDir || "";
      const finalTruncCount = totalTruncatedCount + dropCount;
      const forcedRemoved = finalToCompact.length + reverseBudgetResult.droppedCount + dropCount;
      log.warn(`compact: status=reduced_insufficient_forced removed=${forcedRemoved} truncated=${finalTruncCount} estimatedAfter=${estimatedAfter} preflight=${preflightTokens} compactNum=${compactNum}`);
      return {
        status: CompressionStatus.REDUCED_INSUFFICIENT_FORCED,
        boundary,
        newHistory,
        removedCount: forcedRemoved,
        estimatedAfter,
        truncatedCount: finalTruncCount,
        ...(finalTruncDir !== "" ? { truncatedDir: finalTruncDir } : {}),
      };
    }
    log.warn(`compact: forced-drop skipped to preserve last ${preserveRecentTurns} turn(s) and latest user message (estimatedAfter=${estimatedAfter} preflight=${preflightTokens} compactNum=${compactNum})`);
  }

  const summarizedTruncDir = reverseBudgetDir || perMessageTruncDir || "";
  const summarizedRemoved = finalToCompact.length + reverseBudgetResult.droppedCount;
  log.info(`compact: status=summarized removed=${summarizedRemoved} truncated=${totalTruncatedCount} estimatedAfter=${estimatedAfter} compactNum=${compactNum}`);
  return {
    status: CompressionStatus.SUMMARIZED,
    boundary,
    newHistory,
    removedCount: summarizedRemoved,
    estimatedAfter,
    truncatedCount: totalTruncatedCount,
    ...(summarizedTruncDir !== "" ? { truncatedDir: summarizedTruncDir } : {}),
  };
}

/** Metadata keeps display text unwrapped; model-facing boundary rows add the context fence. */
export function renderBoundaryAsPreamble(boundary: CompactBoundary): string {
  if (boundary.structuredSummary.raw !== undefined && boundary.structuredSummary.raw.length > 0) {
    return boundary.structuredSummary.raw;
  }
  const sectionLines: string[] = [];
  for (const header of SUMMARY_TEMPLATE_HEADERS_V1) {
    const body = boundary.structuredSummary.sections[header];
    if (body) {
      sectionLines.push(`## ${header}`, body, "");
    }
  }

  if (boundary.toolBoundaryLedger.length > 0) {
    sectionLines.push("## Recent Tool Activity Ledger");
    for (const entry of boundary.toolBoundaryLedger) {
      const errFlag = entry.isError ? " [error]" : "";
      sectionLines.push(`- round ${entry.round}: ${entry.toolName}${errFlag} → ${entry.resultSummary}`);
    }
    sectionLines.push("");
  }

  if (boundary.pinnedArtifacts.length > 0) {
    sectionLines.push("## Pinned Artifacts");
    for (const a of boundary.pinnedArtifacts) {
      sectionLines.push(`- ${a}`);
    }
    sectionLines.push("");
  }

  const header = `# Compact #${boundary.compactNum} (${boundary.createdAt})`;
  return [header, "", ...sectionLines].join("\n").trimEnd();
}

/** The recent-turn floor outranks the token ceiling; an oversized singleton may otherwise leave no tail.
 * Align tool pairs with bounded backward adjustment, then remove orphan result prefixes. */
function splitForBoundary(
  messages: GenericMessage[],
  preserveRecentTokens: number,
  preserveRecentTurns = DEFAULT_PRESERVE_RECENT_TURNS,
  preserveUnit: PreserveUnit = "user-turns",
): { toCompact: GenericMessage[]; toPreserve: GenericMessage[]; protectedPreserveCount: number } {
  if (messages.length === 0) {
    return { toCompact: [], toPreserve: [], protectedPreserveCount: 0 };
  }
  const turnPreserveStart = preserveUnit === "tool-rounds"
    ? findRecentToolRoundPreserveStart(messages, preserveRecentTurns)
    : findRecentTurnPreserveStart(messages, preserveRecentTurns);
  const protectedPreserveCount =
    turnPreserveStart < messages.length ? messages.length - turnPreserveStart : 0;
  if (preserveRecentTokens <= 0 && turnPreserveStart >= messages.length) {
    return { toCompact: messages, toPreserve: [], protectedPreserveCount: 0 };
  }
  let preserveStart = messages.length;
  let preservedTokens = 0;
  if (preserveRecentTokens > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateMessageTokensForWire(messages[i]);
      if (preservedTokens + msgTokens > preserveRecentTokens) break;
      preservedTokens += msgTokens;
      preserveStart = i;
    }
  }
  preserveStart = Math.min(preserveStart, turnPreserveStart);
  preserveStart = adjustToToolBoundary(messages, preserveStart);
  // Deep chains can exceed backward adjustment; move orphan result prefixes into the compacted slice.
  preserveStart = adjustForwardToToolBoundary(messages, preserveStart);
  if (preserveUnit === "tool-rounds") {
    // Pin the current question before preserved tool rounds so compaction cannot remove the task itself.
    const pinned = latestRenderableUserIndex(messages, preserveStart);
    if (pinned >= 0) {
      return {
        toCompact: [
          ...messages.slice(0, pinned),
          ...messages.slice(pinned + 1, preserveStart),
        ],
        toPreserve: [messages[pinned], ...messages.slice(preserveStart)],
        // Count the pinned question as protected so forced dropping cannot remove it.
        protectedPreserveCount: protectedPreserveCount + 1,
      };
    }
  }
  return {
    toCompact: messages.slice(0, preserveStart),
    toPreserve: messages.slice(preserveStart),
    protectedPreserveCount,
  };
}

function latestRenderableUserIndex(messages: GenericMessage[], end: number): number {
  for (let i = Math.min(end, messages.length) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && message.meta?.compactBoundary !== true) return i;
  }
  return -1;
}

/** Count assistant tool-call rounds so older work in one active turn remains reducible. */
function findRecentToolRoundPreserveStart(messages: GenericMessage[], keepRounds: number): number {
  const keep = Math.max(0, Math.floor(keepRounds));
  if (keep === 0) return messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) continue;
    seen += 1;
    if (seen === keep) return i;
  }
  return 0;
}

function findRecentTurnPreserveStart(messages: GenericMessage[], preserveRecentTurns: number): number {
  const keepCompletedTurns = Math.max(0, Math.floor(preserveRecentTurns));
  if (keepCompletedTurns === 0) return messages.length;

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && msg.meta?.compactBoundary !== true) {
      userIndices.push(i);
    }
  }
  if (userIndices.length === 0) return messages.length;

  const last = messages[messages.length - 1];
  const trailingPendingUser = last.role === "user" && last.meta?.compactBoundary !== true;
  const turnsToKeep = keepCompletedTurns + (trailingPendingUser ? 1 : 0);
  const startIndex = Math.max(0, userIndices.length - turnsToKeep);
  return userIndices[startIndex] ?? messages.length;
}

/** Bound backward adjustment to avoid collapsing all useful input into the preserve region.
 * Summary input can contain partial pairs; provider replay cannot. */
function adjustToToolBoundary(messages: GenericMessage[], idx: number): number {
  const minIdx = Math.max(0, idx - 3);
  let cur = idx;
  while (cur > minIdx) {
    const m = messages[cur];
    if (m.role === "tool_result") {
      cur--;
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      cur--;
    } else {
      break;
    }
  }
  return cur;
}

/** Advance without a bound past orphan result prefixes in replayed history.
 * An empty preserve tail is valid and safer than an unmatched result. */
function adjustForwardToToolBoundary(messages: GenericMessage[], idx: number): number {
  let cur = idx;
  while (cur < messages.length) {
    const m = messages[cur];
    if (m.role === "tool_result") {
      cur++;
    } else {
      break;
    }
  }
  return cur;
}

function clampDropBeforeLatestRenderableUser(messages: GenericMessage[], dropCount: number): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && message.meta?.compactBoundary !== true) {
      return Math.min(dropCount, i);
    }
  }
  return dropCount;
}

function renderConversation(messages: GenericMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`[user] ${userContentText(msg.content).slice(0, 800)}`);
    } else if (msg.role === "assistant") {
      const tool = msg.toolCalls && msg.toolCalls.length > 0
        ? ` (called: ${msg.toolCalls.map((t) => t.name).join(", ")})`
        : "";
      lines.push(`[assistant${tool}] ${msg.content.slice(0, 800)}`);
    } else {
      const errFlag = msg.isError ? " [error]" : "";
      lines.push(`[tool_result ${msg.toolName ?? "?"}${errFlag}] ${msg.content.slice(0, 400)}`);
    }
  }
  return lines.join("\n");
}

async function callSummaryLLM(args: {
  memoryReviewer: CompactRecapReviewer;
  conversationText: string;
  compactNum: number;
  abortSignal?: AbortSignal;
  focus?: string;
  summaryInputTokens?: number;
}): Promise<string> {
  const isoTime = new Date().toISOString();
  const templateValues: Record<string, string> = {
    conversationText: args.conversationText,
    timestamp: isoTime,
    compactNum: String(args.compactNum),
  };
  const templatePrompt = SUMMARY_TEMPLATE_PROMPT_V1.replace(
    /\{\{(\w+)\}\}/g,
    (_match, key) => templateValues[key] ?? _match,
  );
  const focus = args.focus?.trim().slice(0, MAX_COMPACT_FOCUS_CHARS);
  const filledPrompt = focus
    ? [
        templatePrompt,
        "",
        t("be_structuredCompact.summaryFocusInstruction"),
        "<compact-focus>",
        neutralizeFenceClose(focus, "compact-focus"),
        "</compact-focus>",
      ].join("\n")
    : templatePrompt;

  if (args.summaryInputTokens !== undefined && estimateTokens(filledPrompt) > args.summaryInputTokens * 0.9) {
    throw new Error("Compaction model input exceeds its context budget");
  }
  return (await args.memoryReviewer.review("recap", filledPrompt, {
    systemPrompt: t("be_structuredCompact.callSummarySystemPrompt"),
    ...(args.abortSignal !== undefined && { signal: args.abortSignal }),
  })).trim();
}

function collectPinned(messages: GenericMessage[]): string[] {
  const pinned = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool_result" && msg.toolName === "skill") {
      const head = msg.content.split("\n")[0]?.slice(0, 200) ?? "";
      if (head) pinned.add(`skill:${head}`);
    }
    if (msg.meta?.lock === true) {
      const sig = msg.role === "user"
        ? `lock-user:${userContentText(msg.content).slice(0, 80)}`
        : msg.role === "assistant"
          ? `lock-assistant:${msg.content.slice(0, 80)}`
          : `lock-tool:${msg.toolName ?? "?"}:${msg.content.slice(0, 80)}`;
      pinned.add(sig);
    }
  }
  return Array.from(pinned);
}

function makeToolLedger(messages: GenericMessage[], k: number): ToolCallSummary[] {
  const entries: ToolCallSummary[] = [];
  let round = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      round++;
    }
    if (msg.role !== "tool_result") continue;
    const trimmed = msg.content.length > LEDGER_RESULT_MAX
      ? msg.content.slice(0, LEDGER_RESULT_MAX) + "…"
      : msg.content;
    const entry: ToolCallSummary = {
      round,
      toolName: msg.toolName ?? "?",
      resultSummary: trimmed,
    };
    if (msg.isError) entry.isError = true;
    entries.push(entry);
  }
  return entries.slice(-k);
}
