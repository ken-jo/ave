import { randomUUID } from "node:crypto";
import type { AuditEntry, AuditLogger } from "../../../audit/audit-logger.js";
import type { PermissionAuditEntry, PermissionAuditEntryInput } from "../../../audit/audit-schema.js";
import type { ToolInvocationContext } from "../../reviewer/risk-classifier.js";
import type { JudgeRequest } from "../judge-contract.js";
import { DEFAULT_JUDGE_SETTINGS, type JudgeSettings, type JudgeStageSettings } from "../judge-settings.js";

// A GitHub-token-shaped value the canonical DLP masker must remove (built at runtime).
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
    invocationId: randomUUID(),
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

// A one-stage external chain entry used where the provider is a scripted test judge.
export function scriptedStage(id = "scripted", escalateBelow?: number): JudgeStageSettings {
  return {
    provider: "external",
    id,
    ...(escalateBelow !== undefined ? { escalateBelow } : {}),
    external: { url: "https://judge.example.test/" },
  };
}

export function judgeSettings(overrides: Partial<JudgeSettings> = {}): JudgeSettings {
  return {
    model: null,
    chain: [scriptedStage()],
    mode: "active",
    categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
    timeoutMs: 1_000,
    chainDeadlineMs: DEFAULT_JUDGE_SETTINGS.chainDeadlineMs,
    breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
    ...overrides,
  };
}

export interface CollectingAudit {
  // Plain shadow-channel rows.
  entries: AuditEntry[];
  // HMAC-chain rows (active decisions).
  chained: PermissionAuditEntryInput[];
  logger: Pick<AuditLogger, "logShadow" | "appendPermissionAuditEntry">;
}

export function collectingAudit(): CollectingAudit {
  const entries: AuditEntry[] = [];
  const chained: PermissionAuditEntryInput[] = [];
  return {
    entries,
    chained,
    logger: {
      logShadow: (e: AuditEntry) => void entries.push(e),
      appendPermissionAuditEntry: async (e: PermissionAuditEntryInput) => {
        chained.push(e);
        return { ...e, prevHash: "test" } as PermissionAuditEntry;
      },
    },
  };
}

export function auditPayload(entry: AuditEntry): Record<string, unknown> {
  return JSON.parse(entry.output ?? "{}") as Record<string, unknown>;
}

// Judge records from both channels, shadow first.
export function judgeRecords(audit: Pick<CollectingAudit, "entries" | "chained">): Array<Record<string, unknown>> {
  return [
    ...audit.entries.map(auditPayload),
    ...audit.chained.map((e) => {
      if (e.decision !== "judge") throw new Error(`unexpected chained decision ${e.decision}`);
      return e.judgeRecord as unknown as Record<string, unknown>;
    }),
  ];
}
