/**
 * Permission judge contract (issue #28 P2, judge-model slot).
 *
 * A judge is the single automated-decision seam that runs AFTER hard floors
 * and user deny/ask/allow rules and BEFORE the approval dock. It only decides
 * calls the rules left undecided, and it never writes a rule — it may only
 * suggest one for the dock to show.
 *
 * Providers (`builtin-llm`, `external`) implement {@link PermissionJudge}.
 * The engine ({@link resolveJudge} in `judge-engine.ts`) owns placement,
 * hooks, fallbacks, the circuit breaker and the audit record; providers only
 * answer one request or throw a {@link JudgeFailure}.
 */
import type { RiskVerdict, ToolInvocationContext } from "../reviewer/risk-classifier.js";

export type JudgeDecision = "allow" | "ask" | "deny";

/** Tool categories a judge may be enabled for. `read` / `meta` are never judged. */
export const JUDGE_CATEGORIES = ["shell", "write", "network"] as const;
export type JudgeCategory = (typeof JUDGE_CATEGORIES)[number];

/** `foreground` = a person can be asked now; `headless` = nobody is watching. */
export type JudgeLane = "foreground" | "headless";

/** Why a judge produced no usable verdict. A timeout is recorded apart from denials. */
export type JudgeFailureKind = "timeout" | "error" | "unparseable" | "unavailable";

export interface JudgePolicySnapshot {
  /** Active permission exec mode, e.g. `auto`, `ask`. */
  mode: string;
  /** Project/user policy text the judge should weigh; absent when none. */
  policyText?: string;
}

/**
 * Raw, host-side request. Never leaves the process as-is: the engine derives a
 * {@link RedactedJudgeRequest} for anything that crosses the process boundary
 * (external judges, audit). Tool RESULTS are deliberately absent — the judge
 * sees the user's words and the call, never output a tool produced.
 */
export interface JudgeRequest {
  /**
   * Root conversation session id. Subagents pass their parent's root id so
   * they share one circuit breaker.
   */
  sessionId: string;
  lane: JudgeLane;
  invocation: ToolInvocationContext;
  /** Latest user message(s), oldest first. */
  recentUserMessages: readonly string[];
  projectRoot?: string;
  /** What the host rule classifier concluded for this call. */
  ruleVerdict: RiskVerdict;
  policy: JudgePolicySnapshot;
}

/** The DLP-redacted projection that external judges and the audit log receive. */
export interface RedactedJudgeRequest {
  sessionId: string;
  lane: JudgeLane;
  tool: {
    name: string;
    source: ToolInvocationContext["source"];
    category: ToolInvocationContext["category"];
    input: Record<string, string>;
  };
  recentUserMessages: string[];
  cwd: string;
  projectRoot?: string;
  sandbox: string;
  ruleVerdict: { level: RiskVerdict["level"]; reason: string };
  policy: JudgePolicySnapshot;
}

export interface JudgeVerdict {
  decision: JudgeDecision;
  rationale: string;
  /** 0..1 when the judge reports one. */
  confidence?: number;
  /** A rule the dock MAY offer the user. The judge never writes it. */
  suggestedRule?: string;
}

export interface PermissionJudge {
  /** Provider id, e.g. `builtin-llm`, `external`. */
  readonly id: string;
  /** Provider version recorded with every audit row. */
  readonly version: string;
  /**
   * Answer one request or throw. Throwing a {@link JudgeFailure} names the
   * failure kind; any other throw is treated as `error`. Implementations must
   * stop work when `signal` aborts.
   */
  judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict>;
}

export class JudgeFailure extends Error {
  constructor(
    readonly kind: JudgeFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JudgeFailure";
  }
}

/** Internal contract violation (hooks, request tampering). Never caught by the engine. */
export class JudgeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeContractError";
  }
}

const DECISION_RANK: Record<JudgeDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** True when `next` is the same as or stricter than `prev` (allow < ask < deny). */
export function isSameOrStricter(prev: JudgeDecision, next: JudgeDecision): boolean {
  return DECISION_RANK[next] >= DECISION_RANK[prev];
}

export function isJudgeCategory(category: string): category is JudgeCategory {
  return (JUDGE_CATEGORIES as readonly string[]).includes(category);
}
