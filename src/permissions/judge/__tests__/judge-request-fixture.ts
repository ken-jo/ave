import { randomUUID } from "node:crypto";
import { collectPermissionEvents } from "../../../__tests__/support/permission-events.js";
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

export type JudgeEventCapture = ReturnType<typeof collectPermissionEvents>;

export function collectJudgeEvents(): JudgeEventCapture {
  return collectPermissionEvents();
}

export function judgeRecords(capture: Pick<JudgeEventCapture, "events">) {
  let stages: Record<string, unknown>[] = [];
  const records: Record<string, unknown>[] = [];
  for (const event of capture.events) {
    if (event.event === "permission_judge_stage") stages.push(event);
    if (event.event === "permission_judge") {
      records.push({ ...event, stages });
      stages = [];
    }
  }
  return records;
}
