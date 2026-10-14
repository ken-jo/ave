/**
 * Builds the {@link RedactedJudgeRequest} — the only form of a judge request
 * that may leave the process (external judges) or reach disk (audit).
 *
 * Every free-text value goes through the canonical DLP masker
 * ({@link maskSensitiveData}), and home-directory paths are folded with the
 * shared audit path redactor.
 */
import { createHash } from "node:crypto";
import { maskSensitiveData, redactHomePathsInText } from "../../audit/dlp-filter.js";
import { formatSandboxCapabilityForPrompt } from "../sandbox-capability.js";
import type { JudgeRequest, RedactedJudgeRequest } from "./judge-contract.js";

const MAX_VALUE_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_MESSAGES = 3;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function redactJudgeText(text: string, max = MAX_VALUE_CHARS): string {
  return cap(redactHomePathsInText(maskSensitiveData(text).masked), max);
}

export function redactJudgeRequest(request: JudgeRequest): RedactedJudgeRequest {
  const inv = request.invocation;
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(inv.finalInput)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
    input[key] = redactJudgeText(raw);
  }
  return {
    sessionId: request.sessionId,
    lane: request.lane,
    tool: { name: inv.toolName, source: inv.source, category: inv.category, input },
    recentUserMessages: request.recentUserMessages
      .slice(-MAX_MESSAGES)
      .map((m) => redactJudgeText(m, MAX_MESSAGE_CHARS)),
    cwd: redactJudgeText(inv.executionCwd),
    ...(request.projectRoot !== undefined ? { projectRoot: redactJudgeText(request.projectRoot) } : {}),
    sandbox: redactJudgeText(formatSandboxCapabilityForPrompt(inv.sandboxCapability)),
    ruleVerdict: { level: request.ruleVerdict.level, reason: redactJudgeText(request.ruleVerdict.reason) },
    policy: {
      mode: request.policy.mode,
      ...(request.policy.policyText !== undefined
        ? { policyText: redactJudgeText(request.policy.policyText) }
        : {}),
    },
  };
}

/**
 * Correlation hash of the call's arguments. Computed over the REDACTED input so
 * the hash of a short secret can never be brute-forced back out of the audit.
 */
export function judgeArgsHash(redacted: RedactedJudgeRequest): string {
  const keys = Object.keys(redacted.tool.input).sort();
  const canonical = JSON.stringify([redacted.tool.name, keys.map((k) => [k, redacted.tool.input[k]])]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
