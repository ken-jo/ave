import type { GenericMessage, LLMVendor } from "./llm/types.js";
import { serializeMessageForEstimation } from "./llm/types.js";
import { selectAssistantWireThinkingBlocks } from "./llm/assistant-wire-content.js";
import { hostTpmDefault } from "../shared/model-host-policy.js";
import {
  getUsableContext,
  getPreflightThreshold,
  resolveModelContextWindow,
} from "../shared/context-budget.js";
import { buildToolResultStrippedStub, buildToolResultTruncatedStub } from "../shared/tool-result-stub.js";
import {
  estimateMultimodalTokenOverhead,
  estimateUserMessageTokens,
} from "../shared/multimodal-token-estimate.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { skillNameFromReadResult } from "../main/skill-overlay.js";
import { staleToolResultRewrite } from "./conversation-history.js";

export { countHangul, estimateTokens } from "../shared/token-estimate.js";

// Resolve context windows from settings, endpoint reports, catalog, then the conservative default.

// Resolve the prompt cap and context window from the same route.
function budgetWindow(
  vendor: LLMVendor,
  model: string,
  resolvedContextWindow: number | undefined,
  inputLimit: number | undefined,
): { contextWindow: number; inputLimit?: number } {
  if (resolvedContextWindow !== undefined) {
    return { contextWindow: resolvedContextWindow, ...(inputLimit !== undefined ? { inputLimit } : {}) };
  }
  const resolved = resolveModelContextWindow({ vendor, model });
  return { contextWindow: resolved.contextWindow, ...(resolved.inputLimit !== undefined ? { inputLimit: resolved.inputLimit } : {}) };
}

/** Use context after output and safety reserves as the fullness denominator. */
export function getModelUsableContext(
  vendor: LLMVendor,
  model: string,
  resolvedContextWindow?: number,
  inputLimit?: number,
): number {
  const window = budgetWindow(vendor, model, resolvedContextWindow, inputLimit);
  return getUsableContext(window.contextWindow, window.inputLimit);
}

export function getModelPreflightThreshold(
  vendor: LLMVendor,
  model: string,
  resolvedContextWindow?: number,
  inputLimit?: number,
): number {
  // Priority: runtime override (UI slider) > env var (AVE_DEV_PREFLIGHT_OVERRIDE) > computed.
  if (_runtimePreflightOverride !== null) return _runtimePreflightOverride;
  const devOverride = readDevPreflightOverride();
  if (devOverride !== null) return devOverride;
  const window = budgetWindow(vendor, model, resolvedContextWindow, inputLimit);
  const windowThreshold = getPreflightThreshold(window.contextWindow, window.inputLimit);
  const tpm = hostTpmDefault(vendor, model);
  if (tpm !== undefined) {
    const tpmThreshold = Math.floor(tpm * 0.8);
    return Math.min(windowThreshold, tpmThreshold);
  }
  return windowThreshold;
}

export type PreflightThresholdSource =
  | "runtime-override" | "dev-env-override" | "tpm-capped" | "input-limit" | "context-window";

/** Report the winning threshold source without duplicating threshold calculations. */
export function getModelPreflightThresholdSource(
  vendor: LLMVendor,
  model: string,
  resolvedContextWindow?: number,
  inputLimit?: number,
): PreflightThresholdSource {
  if (_runtimePreflightOverride !== null) return "runtime-override";
  if (readDevPreflightOverride() !== null) return "dev-env-override";
  const window = budgetWindow(vendor, model, resolvedContextWindow, inputLimit);
  const windowThreshold = getPreflightThreshold(window.contextWindow, window.inputLimit);
  const tpm = hostTpmDefault(vendor, model);
  if (tpm !== undefined && Math.floor(tpm * 0.8) < windowThreshold) return "tpm-capped";
  return windowThreshold < getPreflightThreshold(window.contextWindow) ? "input-limit" : "context-window";
}

let _devOverrideWarnedValue: number | null | undefined = undefined;
let _runtimePreflightOverride: number | null = null;

function readDevPreflightOverride(): number | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = process.env.AVE_DEV_PREFLIGHT_OVERRIDE;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  if (_devOverrideWarnedValue !== n) {
    // eslint-disable-next-line no-console
    console.warn(`[ave] dev preflight override active: AVE_DEV_PREFLIGHT_OVERRIDE=${n} tokens (ignored in production NODE_ENV)`);
    _devOverrideWarnedValue = n;
  }
  return n;
}

// Runtime overrides are development-only; null restores environment or computed thresholds.
export function setRuntimePreflightOverride(n: number | null): void {
  if (process.env.NODE_ENV === "production") return;
  if (n === null) {
    _runtimePreflightOverride = null;
    return;
  }
  if (!Number.isFinite(n) || n <= 0) return;
  _runtimePreflightOverride = Math.floor(n);
}

export function getRuntimePreflightOverride(): number | null {
  return _runtimePreflightOverride;
}

// Compaction checkpoints stay in-session; automatic session splitting is unsupported.

// Message estimation stays in engine because wire shapes and stubbing depend on engine types.

/** Estimate provider-wire content, retaining unknown-route signed reasoning conservatively.
 * Display-only thought does not count; live tool images count on every API-key route. */
export function estimateMessageTokensForWire(message: GenericMessage, vendor?: LLMVendor): number {
  if (message.role === "user") return estimateUserMessageTokens(message.content);

  // Count marked results as wire stubs while preserving their raw inspection content in memory.
  let total = estimateTokens(serializeMessageForWireEstimate(message, vendor));

  // Count sibling images only while live, using the serializer stub predicate.
  if (
    message.role === "tool_result" &&
    message.image !== undefined &&
    // Routes send images inline or in a derived user row after the result group.
    message.meta?.compactedAt === undefined &&
    message.meta?.truncated === undefined &&
    message.meta?.serializedStub !== true
  ) {
    total += estimateMultimodalTokenOverhead([
      { type: "image", width: message.image.width, height: message.image.height },
    ]);
  }
  return total;
}

export function estimateMessagesTokens(messages: GenericMessage[], vendor?: LLMVendor): number {
  return messages.reduce((total, message) => total + estimateMessageTokensForWire(message, vendor), 0);
}

function serializeMessageForWireEstimate(message: GenericMessage, vendor?: LLMVendor): string {
  if (message.role === "assistant") {
    return serializeMessageForEstimation({
      ...message,
      thought: undefined,
      thinkingBlocks: selectAssistantWireThinkingBlocks(message.thinkingBlocks, vendor),
    });
  }
  if (message.role !== "tool_result") {
    return serializeMessageForEstimation(message);
  }
  if (message.meta?.serializedStub === true) {
    return serializeMessageForEstimation(message);
  }

  const content = message.meta?.truncated !== undefined
    ? buildToolResultTruncatedStub(message.toolUseId, message.toolName, message.meta.truncated, message.content)
    : message.meta?.compactedAt !== undefined
      ? buildToolResultStrippedStub(message.toolName, message.content.length)
      : message.content;

  return serializeMessageForEstimation({
    ...message,
    content,
  });
}

// compactedAt marks serialization stubs; memory retains raw text and disk keeps a file-backed artifact.

export interface MarkStaleConfig {
  preserveRecentToolResults: number;
  // Results below this character threshold save too little to justify stubbing.
  minStubThreshold?: number;
}

export interface MarkStaleResult {
  marked: boolean;
  markedCount: number;
  // Estimated UTF-16 code units freed, including dropped image content.
  freedCharsOnSerialize: number;
}

const DEFAULT_MARK_STALE_CONFIG: MarkStaleConfig = {
  preserveRecentToolResults: 8,
  minStubThreshold: 200,
};

/** Mark without mutating raw content or input rows; skip recent, tiny, and already-marked results.
 * Preserve each skill latest successful read so its instructions remain available. */
export function markStaleToolResults(
  messages: GenericMessage[],
  config: MarkStaleConfig = DEFAULT_MARK_STALE_CONFIG,
): { messages: GenericMessage[]; result: MarkStaleResult } {
  const preserveCount = Math.max(0, config.preserveRecentToolResults);
  const minStub = config.minStubThreshold ?? DEFAULT_MARK_STALE_CONFIG.minStubThreshold ?? 200;

  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool_result") toolResultIndices.push(i);
  }

  if (toolResultIndices.length <= preserveCount) {
    return {
      messages,
      result: { marked: false, markedCount: 0, freedCharsOnSerialize: 0 },
    };
  }

  const markCandidates = toolResultIndices.slice(0, toolResultIndices.length - preserveCount);
  const activeSkillReads = latestSkillReadIndices(messages, toolResultIndices);
  const eligibleCandidates = markCandidates.filter((i) => {
    const m = messages[i];
    if (m.role !== "tool_result") return false;
    if (m.meta?.compactedAt !== undefined) return false;
    // Stubbing the latest skill body would silently drop active task instructions.
    if (activeSkillReads.has(i)) return false;
    // Image-only results need marking even when their text placeholder is below the size threshold.
    return m.content.length >= minStub || m.image !== undefined;
  });
  if (eligibleCandidates.length === 0) {
    return {
      messages,
      result: { marked: false, markedCount: 0, freedCharsOnSerialize: 0 },
    };
  }
  const markCandidateIdxSet = new Set(eligibleCandidates);

  let markedCount = 0;
  let freedCharsOnSerialize = 0;
  const nowIso = new Date().toISOString();

  const out = messages.map((msg, i) => {
    if (!markCandidateIdxSet.has(i)) return msg;
    if (msg.role !== "tool_result") return msg;

    const originalLength = msg.content.length;
    // Measure the stripped stub; truncated stubs are longer and report different savings.
    const strippedStubLength = buildToolResultStrippedStub(msg.toolName, originalLength).length;
    freedCharsOnSerialize += Math.max(0, originalLength - strippedStubLength);
    // Include dropped base64 siblings in freed size.
    freedCharsOnSerialize += msg.image?.data.length ?? 0;
    markedCount += 1;

    // The raw content stays; compactedAt makes the wire serialize it as a stub, and the image goes.
    return staleToolResultRewrite(msg, { dropImage: true, compactedAt: nowIso });
  });

  return {
    messages: out,
    result: {
      marked: markedCount > 0,
      markedCount,
      freedCharsOnSerialize,
    },
  };
}

// Preserve the latest successful unmarked skill read; earlier duplicates remain eligible.
function latestSkillReadIndices(messages: GenericMessage[], toolResultIndices: number[]): Set<number> {
  const latestBySkill = new Map<string, number>();
  for (const i of toolResultIndices) {
    const m = messages[i];
    if (m.role !== "tool_result" || m.toolName !== "skill_load" || m.isError) continue;
    if (m.meta?.compactedAt !== undefined) continue;
    const skillName = skillNameFromReadResult(m.content);
    if (skillName) latestBySkill.set(skillName, i);
  }
  return new Set(latestBySkill.values());
}

export interface EvictImagesResult {
  evicted: boolean;
  evictedCount: number;
  freedChars: number;
}

/** Evict aged images regardless of token pressure; preserve recent images and all text.
 * The protect window exceeds a round fan-out, so every image is sent before aging out. */
export function evictAgedToolResultImages(
  messages: GenericMessage[],
  preserveRecent: number,
): { messages: GenericMessage[]; result: EvictImagesResult } {
  const preserve = Math.max(0, preserveRecent);
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool_result") toolResultIndices.push(i);
  }
  if (toolResultIndices.length <= preserve) {
    return { messages, result: { evicted: false, evictedCount: 0, freedChars: 0 } };
  }

  const agedIdx = new Set(toolResultIndices.slice(0, toolResultIndices.length - preserve));
  let evictedCount = 0;
  let freedChars = 0;
  const out = messages.map((msg, i) => {
    if (!agedIdx.has(i) || msg.role !== "tool_result" || msg.image === undefined) return msg;
    freedChars += msg.image.data.length;
    evictedCount += 1;
    return staleToolResultRewrite(msg, { dropImage: true });
  });

  return {
    messages: out,
    result: { evicted: evictedCount > 0, evictedCount, freedChars },
  };
}

/** Match context-limit messages and Error codes; HTTP status and error.type are not inspected. */
export function isContextLengthError(err: unknown): boolean {
  let rawMsg: string;
  if (err instanceof Error) {
    rawMsg = err.message;
  } else if (typeof err === "string") {
    rawMsg = err;
  } else if (err !== null && typeof err === "object") {
    const asObj = err as Record<string, unknown>;
    rawMsg = typeof asObj["message"] === "string"
      ? asObj["message"]
      : typeof asObj["error"] === "string"
        ? asObj["error"]
        : "";
  } else {
    return false;
  }

  const msg = rawMsg.toLowerCase();
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === "context_length_exceeded") return true;
  }

  if (msg.includes("prompt is too long")) return true;

  if (msg.includes("maximum context length")) return true;

  if ((msg.includes("exceeds the maximum") && msg.includes("token")) ||
      msg.includes("input token count") ||
      msg.includes("context window")) return true;

  return false;
}
