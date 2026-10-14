/**
 * Judge engine — placement, hooks, fallbacks, circuit breaker and audit for one
 * tool call. Pure with respect to permission state: it reads the rule outcome
 * the caller already computed and returns what the judge contributes. It does
 * no deferred-queue I/O and writes no rules.
 *
 * Placement: floors → user deny/ask → user allow → mode matrix → JUDGE → dock.
 * The judge runs only when every earlier layer left the call undecided, the
 * call's category is enabled, and the call is not one the judge may never
 * decide (strict mode, plugin/agent capability grants, remote-controller
 * requests).
 *
 * Lanes: in `headless` nobody can be asked, so any non-allow becomes
 * `deny` with `defer: true` — the call site appends it to the existing
 * deferred queue.
 *
 * Fallbacks (timeout, error, unparseable, unavailable) never allow: `ask` in
 * the foreground, `deny` + defer headless. Timeouts are tagged apart and, like
 * every fallback, never count toward the breaker.
 *
 * `shadow` mode runs the judge and audits the result, but `applied` is false:
 * the caller keeps today's path and the user still decides.
 */
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { RiskVerdict } from "../reviewer/risk-classifier.js";
import {
  isJudgeCategory,
  isSameOrStricter,
  JudgeContractError,
  JudgeFailure,
  type JudgeDecision,
  type JudgeFailureKind,
  type JudgeRequest,
  type JudgeVerdict,
  type PermissionJudge,
  type RedactedJudgeRequest,
} from "./judge-contract.js";
import type { JudgeCircuitBreaker } from "./judge-breaker.js";
import { judgeArgsHash, redactJudgeRequest, redactJudgeText } from "./judge-redaction.js";
import type { JudgeMode, JudgeSettings } from "./judge-settings.js";

export type PriorRuleDecision = "allow" | "ask" | "deny" | "undecided";

/** What the layers before the judge concluded about this call. */
export interface JudgeGate {
  /** Outcome of floors + user rules + mode matrix; the judge runs only on `undecided`. */
  priorDecision: PriorRuleDecision;
  strictMode: boolean;
  /** Plugin or agent capability grant — never judge-decidable. */
  capabilityGrant: boolean;
  /** Request raised by a remote controller — never judge-decidable. */
  remoteController: boolean;
}

export type BeforeJudgeResult =
  | { action: "continue"; request?: JudgeRequest }
  | { action: "short-circuit"; decision: "ask" | "deny"; reason: string };

export interface JudgeHooks {
  /** May redact the request (same call identity) or short-circuit to ask/deny. */
  beforeJudge?(request: JudgeRequest): BeforeJudgeResult | Promise<BeforeJudgeResult>;
  /** May only keep or downgrade the verdict (allow → ask → deny). */
  afterJudge?(verdict: JudgeVerdict, request: JudgeRequest): JudgeDecision | Promise<JudgeDecision>;
}

export interface JudgeEngineDeps {
  settings: JudgeSettings;
  /** The configured provider; null when it could not be constructed (→ `unavailable`). */
  judge: PermissionJudge | null;
  breaker: JudgeCircuitBreaker;
  audit: Pick<AuditLogger, "logShadow">;
  hooks?: JudgeHooks;
  now?: () => number;
}

export type JudgeSkipReason =
  | "provider-off"
  | "rule-decided"
  | "strict-mode"
  | "capability-grant"
  | "remote-controller"
  | "category-not-judged"
  | "category-disabled"
  | "breaker-open";

export type JudgeOutcomeSource = "judge" | "hook" | "fallback";

export interface JudgeAuditRecord {
  event: "permission-judge";
  ts: string;
  session: string;
  lane: JudgeRequest["lane"];
  mode: JudgeMode;
  tool: string;
  category: string;
  argsHash: string;
  redactedRequest: RedactedJudgeRequest;
  judge: { id: string; version: string } | null;
  /** The judge's own verdict decision; null when no verdict was produced. */
  verdictDecision: JudgeDecision | null;
  /** Decision after hooks, lanes and fallbacks. */
  decision: JudgeDecision;
  applied: boolean;
  source: JudgeOutcomeSource;
  rationale: string;
  latencyMs: number;
  fallback: JudgeFailureKind | null;
  breakerTripped: boolean;
}

export type JudgeOutcome =
  | { judged: false; skip: JudgeSkipReason }
  | {
      judged: true;
      mode: JudgeMode;
      decision: JudgeDecision;
      /** False in shadow mode: the caller must keep its pre-judge path. */
      applied: boolean;
      /** Headless non-allow: the call site appends to the deferred queue. */
      defer: boolean;
      /** Present when `defer`: the verdict and summary the deferred entry carries. */
      deferral?: { verdict: RiskVerdict; inputSummary: string };
      source: JudgeOutcomeSource;
      fallback?: JudgeFailureKind;
      /** Rule the dock MAY offer; never persisted by the engine. */
      suggestedRule?: string;
      rationale: string;
      breakerTripped: boolean;
    };

function skipReason(gate: JudgeGate, request: JudgeRequest, deps: JudgeEngineDeps): JudgeSkipReason | null {
  if (deps.settings.provider === "off") return "provider-off";
  if (gate.priorDecision !== "undecided") return "rule-decided";
  if (gate.strictMode) return "strict-mode";
  if (gate.capabilityGrant) return "capability-grant";
  if (gate.remoteController) return "remote-controller";
  const category = request.invocation.category;
  if (!isJudgeCategory(category)) return "category-not-judged";
  if (!deps.settings.categories[category]) return "category-disabled";
  if (deps.breaker.isOpen(request.sessionId)) return "breaker-open";
  return null;
}

function assertSameCall(original: JudgeRequest, next: JudgeRequest): void {
  const a = original.invocation;
  const b = next.invocation;
  if (
    next.sessionId !== original.sessionId ||
    next.lane !== original.lane ||
    b.toolName !== a.toolName ||
    b.source !== a.source ||
    b.category !== a.category
  ) {
    throw new JudgeContractError("beforeJudge may redact the request but must not change the call identity");
  }
}

interface JudgeRun {
  verdict?: JudgeVerdict;
  fallback?: JudgeFailureKind;
  failureMessage?: string;
}

async function runJudge(
  judge: PermissionJudge | null,
  request: JudgeRequest,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<JudgeRun> {
  if (!judge) return { fallback: "unavailable", failureMessage: "judge provider unavailable" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new JudgeFailure("timeout", `judge timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const verdict = await Promise.race([
      judge.judge(request, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }),
    ]);
    return { verdict };
  } catch (err) {
    // A user cancel is not a judge failure: propagate it to the caller.
    if (callerSignal?.aborted && !timedOut) throw callerSignal.reason;
    if (timedOut) return { fallback: "timeout", failureMessage: `judge timed out after ${timeoutMs}ms` };
    if (err instanceof JudgeContractError) throw err;
    if (err instanceof JudgeFailure) return { fallback: err.kind, failureMessage: err.message };
    return { fallback: "error", failureMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function writeAudit(deps: JudgeEngineDeps, record: JudgeAuditRecord): void {
  deps.audit.logShadow({
    timestamp: record.ts,
    sessionId: record.session,
    type: "info",
    input: `permission-judge ${record.tool} decision=${record.decision} applied=${record.applied}`,
    output: JSON.stringify(record),
  });
}

/**
 * Decide what the judge contributes to one tool call. Returns `judged: false`
 * when the judge must not run; the caller then continues exactly as without a
 * judge. Throws only for internal contract violations or a caller abort.
 */
export async function resolveJudge(
  gate: JudgeGate,
  request: JudgeRequest,
  deps: JudgeEngineDeps,
  signal?: AbortSignal,
): Promise<JudgeOutcome> {
  const skip = skipReason(gate, request, deps);
  if (skip) return { judged: false, skip };

  const now = deps.now ?? Date.now;
  const started = now();
  const mode = deps.settings.mode;
  let effective = request;
  let source: JudgeOutcomeSource;
  let verdict: JudgeVerdict | undefined;
  let fallback: JudgeFailureKind | undefined;
  let decision: JudgeDecision;
  let rationale: string;

  const before = deps.hooks?.beforeJudge ? await deps.hooks.beforeJudge(request) : { action: "continue" as const };
  if (before.action === "short-circuit") {
    if (before.decision !== "ask" && before.decision !== "deny") {
      throw new JudgeContractError("beforeJudge may only short-circuit to ask or deny");
    }
    source = "hook";
    decision = before.decision;
    rationale = before.reason;
  } else {
    if (before.request) {
      assertSameCall(request, before.request);
      effective = before.request;
    }
    const run = await runJudge(deps.judge, effective, deps.settings.timeoutMs, signal);
    if (run.verdict) {
      verdict = run.verdict;
      source = "judge";
      decision = verdict.decision;
      rationale = verdict.rationale;
      if (deps.hooks?.afterJudge) {
        const after = await deps.hooks.afterJudge(verdict, effective);
        if (!isSameOrStricter(verdict.decision, after)) {
          throw new JudgeContractError(`afterJudge may only downgrade (got ${verdict.decision} → ${String(after)})`);
        }
        decision = after;
      }
    } else {
      source = "fallback";
      fallback = run.fallback;
      decision = "ask";
      rationale = run.failureMessage ?? "judge failed";
    }
  }

  const headless = request.lane === "headless";
  if (headless && decision === "ask") decision = "deny";
  const applied = mode === "active";
  // Shadow must never change behavior, so it never asks the call site to defer.
  const defer = applied && headless && decision !== "allow";

  let breakerTripped = false;
  if (applied && source === "judge" && verdict) {
    breakerTripped = deps.breaker.record(request.sessionId, verdict.decision);
  }

  const redacted = redactJudgeRequest(effective);
  const safeRationale = redactJudgeText(rationale, 2_000);
  writeAudit(deps, {
    event: "permission-judge",
    ts: new Date(started).toISOString(),
    session: request.sessionId,
    lane: request.lane,
    mode,
    tool: request.invocation.toolName,
    category: request.invocation.category,
    argsHash: judgeArgsHash(redacted),
    redactedRequest: redacted,
    judge: deps.judge ? { id: deps.judge.id, version: deps.judge.version } : null,
    verdictDecision: verdict?.decision ?? null,
    decision,
    applied,
    source,
    rationale: safeRationale,
    latencyMs: Math.max(0, now() - started),
    fallback: fallback ?? null,
    breakerTripped,
  });

  return {
    judged: true,
    mode,
    decision,
    applied,
    defer,
    ...(defer
      ? {
          deferral: {
            verdict: { level: "high", reason: `judge ${source}: ${safeRationale}` },
            inputSummary: JSON.stringify(redacted.tool.input).slice(0, 2_000),
          },
        }
      : {}),
    source,
    ...(fallback ? { fallback } : {}),
    ...(verdict?.suggestedRule ? { suggestedRule: verdict.suggestedRule } : {}),
    rationale: safeRationale,
    breakerTripped,
  };
}
