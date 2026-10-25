/** Share the gate’s rate, dedupe, and denial state across HostApi instances. */
import type { AuditEntry } from "../../../audit/audit-logger.js";
import type {
  ConversationTriggerResult,
  ConversationTriggerSpec,
} from "../../../plugins/types.js";
import { isPluginOverlaySource } from "../../../shared/overlay-trigger-source.js";
import { CAPABILITY_HOST_OVERLAY } from "../../../plugins/capabilities.js";
import { formatStagedEnvelope, stagedOriginFor } from "../../../shared/staged-origins.js";
import { stripLeadingSlash } from "../../../shared/slash-sanitizer.js";
import { stripUntrustedTags } from "../../../lib/strip-untrusted-tags.js";
import { t } from "../../../i18n/index.js";
import type { SuggestionLedger } from "../../../alerts/suggestion-ledger.js";

/** Dedupe per plugin with a short TTL; long-term suppression belongs to the plugin. */
export const TRIGGER_CONVERSATION_DEDUPE_TTL_MS = 5 * 60 * 1000;

export class TriggerConversationDedupe {
  private readonly seen = new Map<string, number>();
  private key(pluginId: string, dedupeKey: string): string {
    return `${pluginId}::${dedupeKey}`;
  }
  has(pluginId: string, dedupeKey: string): boolean {
    const key = this.key(pluginId, dedupeKey);
    const seenAt = this.seen.get(key);
    if (seenAt === undefined) return false;
    if (Date.now() - seenAt > TRIGGER_CONVERSATION_DEDUPE_TTL_MS) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }
  record(pluginId: string, dedupeKey: string): void {
    // Delete before set to refresh insertion order; Map.set alone does not implement LRU.
    const key = this.key(pluginId, dedupeKey);
    if (this.seen.has(key)) this.seen.delete(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > 256) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
  }
}

const ALLOWED_VISIBILITIES: ReadonlySet<"silent" | "summary-only" | "user-visible"> = new Set([
  "silent",
  "summary-only",
  "user-visible",
] as const);
const ALLOWED_PRIORITIES: ReadonlySet<"low" | "normal" | "high"> = new Set([
  "low",
  "normal",
  "high",
] as const);
/** Bound dedupeKey length so a malicious / buggy plugin cannot bloat audit logs. */
const MAX_DEDUPE_KEY_LEN = 128;
/** Cap templated prompts to prevent whole-document dumps from exhausting context. */
const MAX_PROMPT_LEN = 4096;
// Use the shared bounded source grammar; double-dash sources are reserved for host alerts.

/** Rate-limit per plugin so rotated or omitted dedupe keys cannot bypass the cap. */
export const TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS = 60_000;
export const TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS = 6;

/** Plugin provenance survives user confirmation; overlay prompts must never dispatch privileged slash commands. */
export function sanitizePluginPendingPrompt(prompt: string): string {
  return stripLeadingSlash(prompt);
}

/** Use shared staged-origin sanitization so plugin text cannot close its provenance fence. */
export function formatPluginPendingPrompt(prompt: string, source: string): string {
  return formatStagedEnvelope(stagedOriginFor("plugin-emitted"), prompt, source);
}

export const OVERLAY_SUMMARY_DISPLAY_CAP = 2_000;

/** Bound and strip provenance wrappers from previews; retain the full prompt separately. */
export function deriveOverlaySummaryForDisplay(
  spec: Pick<ConversationTriggerSpec, "prompt" | "summary">,
): string {
  const rawSummary = spec.summary != null ? spec.summary : spec.prompt;
  const stripped = stripUntrustedTags(rawSummary);
  if (stripped.length > OVERLAY_SUMMARY_DISPLAY_CAP) {
    const marker = t("be_pluginRuntime.overlaySummaryTruncationMarker");
    const cap = OVERLAY_SUMMARY_DISPLAY_CAP - marker.length;
    return stripped.slice(0, cap) + marker;
  }
  return stripped;
}

export class TriggerConversationRateLimiter {
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private readonly recent = new Map<string, number[]>();

  constructor(
    windowMs: number = TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS,
    maxCalls: number = TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS,
  ) {
    this.windowMs = windowMs;
    this.maxCalls = maxCalls;
  }

  /** Compact timestamps during cap checks so repeated denials cannot grow the map unboundedly. */
  isOverCap(pluginId: string, now: number = Date.now()): boolean {
    const calls = this.recent.get(pluginId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = calls.filter((t) => t >= cutoff);
    if (fresh.length !== calls.length) this.recent.set(pluginId, fresh);
    return fresh.length >= this.maxCalls;
  }

  record(pluginId: string, now: number = Date.now()): void {
    const calls = this.recent.get(pluginId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = calls.filter((t) => t >= cutoff);
    fresh.push(now);
    this.recent.set(pluginId, fresh);
  }
}

export const triggerConversationRateLimiter = new TriggerConversationRateLimiter();

/** User-initiated server reads share a separate budget; keep it independent of context attachment limits. */
export const USER_PROMPT_RATE_LIMIT_MAX_CALLS = 48;
export const userPromptRateLimiter = new TriggerConversationRateLimiter(
  TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS,
  USER_PROMPT_RATE_LIMIT_MAX_CALLS,
);

/** Throttle denial audits separately because rejected input never consumes the acceptance rate limit. */
const TRIGGER_DENY_AUDIT_WINDOW_MS = 60_000;

export class TriggerDenyAuditThrottle {
  private readonly windowMs: number;
  private readonly state = new Map<string, { suppressedSince: number; count: number }>();

  constructor(windowMs: number = TRIGGER_DENY_AUDIT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Emit the first denial, suppress repeats during the window, then report the suppressed count. */
  shouldEmit(pluginId: string, reason: string, now: number = Date.now()): boolean {
    const key = `${pluginId}::${reason}`;
    const entry = this.state.get(key);
    if (entry === undefined) {
      this.state.set(key, { suppressedSince: now, count: 0 });
      return true;
    }
    if (now - entry.suppressedSince >= this.windowMs) {
      this.state.set(key, { suppressedSince: now, count: 0 });
      return true;
    }
    entry.count += 1;
    return false;
  }

  /** Drain and reset suppressed counts for the next emitted audit row. */
  drainSuppressed(pluginId: string, reason: string): number {
    const entry = this.state.get(`${pluginId}::${reason}`);
    if (!entry) return 0;
    const n = entry.count;
    entry.count = 0;
    return n;
  }
}

export const triggerDenyAuditThrottle = new TriggerDenyAuditThrottle();

/** Returns a normalized allow or denial and writes its audit row; callers must not duplicate bookkeeping. */
export interface EvaluateTriggerSpecInput {
  /** Host delivery precondition, checked after input validation and before state changes. */
  assertDeliveryAvailable?: () => void;
  /** Synchronously stage delivery before any acceptance budget is charged. */
  stageDelivery?: (source: string) => void;
  spec: ConversationTriggerSpec | undefined | null;
  pluginId: string;
  capabilities: readonly string[];
  dedupe: TriggerConversationDedupe;
  rateLimiter: TriggerConversationRateLimiter;
  denyAuditThrottle?: TriggerDenyAuditThrottle;
  /** Alert-contract plugins accept only declared sources; load the acceptance ledger before evaluating. */
  suggestions?: {
    declared: readonly string[];
    ledger: Pick<SuggestionLedger, "isLimited" | "record">;
  };
  auditLogger: { log(entry: AuditEntry): void };
  now?: () => number;
}

export type EvaluateTriggerSpecOutcome =
  | { kind: "deny"; result: ConversationTriggerResult }
  | {
      kind: "allow";
      result: ConversationTriggerResult;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
    };

export function evaluateTriggerSpec(
  input: EvaluateTriggerSpecInput,
): EvaluateTriggerSpecOutcome {
  const {
    spec,
    pluginId,
    capabilities,
    dedupe,
    rateLimiter,
    auditLogger,
  } = input;
  const denyAuditThrottle = input.denyAuditThrottle;
  const now = input.now ?? Date.now;

  // Validate the original source; truncating first could turn invalid input into a valid prefix.
  const source = typeof spec?.source === "string" ? spec.source : "";
  const { visibility, priority, dedupeKey } = normalizeTriggerSpecFields(
    spec ?? ({} as ConversationTriggerSpec),
  );

  const auditDeny = (reasonInput: string) => {
    // Throttle denials independently by plugin and the first reason token.
    const reasonKey = (/reason=([a-z_]+)/.exec(reasonInput)?.[1]) ?? "unknown";
    if (denyAuditThrottle && !denyAuditThrottle.shouldEmit(pluginId, reasonKey, now())) {
      return;
    }
    const suppressed = denyAuditThrottle?.drainSuppressed(pluginId, reasonKey) ?? 0;
    try {
      auditLogger.log({
        timestamp: new Date(now()).toISOString(),
        sessionId: "plugin",
        type: "error",
        input:
          `[plugin:${pluginId}] trigger_conversation_denied ${reasonInput}` +
          (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
      });
    } catch { /* audit must not break host */ }
  };

  if (!capabilities.includes(CAPABILITY_HOST_OVERLAY)) {
    auditDeny("reason=capability_denied");
    return {
      kind: "deny",
      result: { accepted: false, reason: "capability_denied", source: "" },
    };
  }
  if (!isPluginOverlaySource(source)) {
    auditDeny(`reason=invalid_source source=${source.slice(0, 32) || "<empty>"}`);
    return {
      kind: "deny",
      // Bound source echoes so oversized input cannot inflate caller-visible errors.
      result: { accepted: false, reason: "invalid_source", source: source.slice(0, 32) },
    };
  }
  const suggestions = input.suggestions;
  if (suggestions && !suggestions.declared.includes(source)) {
    auditDeny(`reason=source_not_declared source=${source}`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "source_not_declared", source },
    };
  }
  if (typeof spec?.prompt !== "string" || spec.prompt.trim().length === 0) {
    auditDeny(`reason=invalid_source source=${source} (empty prompt)`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "invalid_source", source },
    };
  }
  if (spec.prompt.length > MAX_PROMPT_LEN) {
    auditDeny(`reason=invalid_source source=${source} (prompt>${MAX_PROMPT_LEN})`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "invalid_source", source },
    };
  }
  input.assertDeliveryAvailable?.();
  if (rateLimiter.isOverCap(pluginId, now())) {
    auditDeny("reason=rate_limited");
    return {
      kind: "deny",
      result: { accepted: false, reason: "rate_limited", source },
    };
  }
  if (suggestions && suggestions.ledger.isLimited(pluginId, source, now())) {
    auditDeny(`reason=suggestion_limit source=${source}`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "suggestion_limit", source },
    };
  }
  if (dedupeKey && dedupe.has(pluginId, dedupeKey)) {
    auditDeny(`reason=duplicate dedupeKey=${dedupeKey}`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "duplicate", source },
    };
  }

  input.stageDelivery?.(source);

  // Advance dedupe and rate state before returning acceptance.
  if (dedupeKey) dedupe.record(pluginId, dedupeKey);
  rateLimiter.record(pluginId, now());
  suggestions?.ledger.record(pluginId, source, now());

  // Context-key names can carry PII; audit only strict identifiers and count the rest.
  let contextSuffix = "";
  if (spec?.context) {
    const KEY_SHAPE = /^[a-zA-Z_][a-zA-Z0-9_]{0,32}$/;
    const allKeys = Object.keys(spec.context);
    const okKeys = allKeys.filter((k) => KEY_SHAPE.test(k));
    const badCount = allKeys.length - okKeys.length;
    const parts: string[] = [];
    if (okKeys.length > 0) parts.push(`contextKeys=${okKeys.slice(0, 8).join(",")}`);
    if (badCount > 0) parts.push(`contextKeysOmitted=${badCount}`);
    if (parts.length > 0) contextSuffix = ` ${parts.join(" ")}`;
  }
  try {
    auditLogger.log({
      timestamp: new Date(now()).toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input:
        `[plugin:${pluginId}] trigger_conversation source=${source} ` +
        `visibility=${visibility} priority=${priority}` +
        (dedupeKey ? ` dedupeKey=${dedupeKey}` : "") +
        contextSuffix,
    });
  } catch { /* audit must not break host */ }

  return {
    kind: "allow",
    result: { accepted: true, source },
    source,
    visibility,
    priority,
  };
}

/** Normalize untrusted fields before audit: default unknown enums and drop non-string dedupe keys. */
export function normalizeTriggerSpecFields(spec: ConversationTriggerSpec): {
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  dedupeKey: string | undefined;
} {
  const visibility = ALLOWED_VISIBILITIES.has(
    spec.visibility as "silent" | "summary-only" | "user-visible",
  )
    ? (spec.visibility as "silent" | "summary-only" | "user-visible")
    : "summary-only";
  const priority = ALLOWED_PRIORITIES.has(
    spec.priority as "low" | "normal" | "high",
  )
    ? (spec.priority as "low" | "normal" | "high")
    : "normal";
  let dedupeKey: string | undefined;
  if (typeof spec.dedupeKey === "string") {
    const trimmed = spec.dedupeKey.trim();
    if (trimmed.length > 0) {
      dedupeKey = trimmed.length > MAX_DEDUPE_KEY_LEN
        ? trimmed.slice(0, MAX_DEDUPE_KEY_LEN)
        : trimmed;
    }
  }
  return { visibility, priority, dedupeKey };
}

export const triggerConversationDedupe = new TriggerConversationDedupe();
