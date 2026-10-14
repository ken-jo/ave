import type { AuditEntry, AuditLogger } from "../../../audit/audit-logger.js";
import type { ToolInvocationContext } from "../../reviewer/risk-classifier.js";
import type { JudgeRequest } from "../judge-contract.js";
import { DEFAULT_JUDGE_SETTINGS, type JudgeSettings } from "../judge-settings.js";

/** A GitHub-token-shaped value the canonical DLP masker must remove (built at runtime). */
export const PLANTED_CREDENTIAL = ["ghp", "_", "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5"].join("");

export function judgeInvocation(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return {
    toolName: "bash",
    source: "builtin",
    category: "shell",
    pathFields: [],
    trustOrigin: "user-keyboard",
    finalInput: { command: "npm run build" },
    executionCwd: "/workspace/sample",
    allowedDirectories: ["/workspace/sample"],
    sensitivePathsAdjacent: [],
    sandboxCapability: { kind: "none", confidence: "verified", platform: "linux", reason: "no sandbox" },
    ...overrides,
  };
}

export function judgeRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    sessionId: "session-root",
    lane: "foreground",
    invocation: judgeInvocation(),
    recentUserMessages: ["please build the project"],
    projectRoot: "/workspace/sample",
    ruleVerdict: { level: "medium", reason: "shell command" },
    policy: { mode: "ask" },
    ...overrides,
  };
}

export function judgeSettings(overrides: Partial<JudgeSettings> = {}): JudgeSettings {
  return {
    provider: "builtin-llm",
    mode: "active",
    categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
    timeoutMs: 1_000,
    breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
    ...overrides,
  };
}

export function collectingAudit(): { entries: AuditEntry[]; logger: Pick<AuditLogger, "logShadow"> } {
  const entries: AuditEntry[] = [];
  return { entries, logger: { logShadow: (e: AuditEntry) => void entries.push(e) } };
}

export function auditPayload(entry: AuditEntry): Record<string, unknown> {
  return JSON.parse(entry.output ?? "{}") as Record<string, unknown>;
}
