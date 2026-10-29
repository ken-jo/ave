// Judges cannot decide strict mode, capability grants or remote-controller calls and cannot override earlier floors/rules/matrix decisions. Run stages in order; ask, missing/low confidence and failures escalate.
// Only a confident final allow/deny applies; unresolved or failed chains ask foreground and deny headless, never allow by fallback. Count final denials only; shadow mode audits without changing permission or writing rules.
import { randomUUID } from "node:crypto";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { errorMessage } from "../../shared/error-message.js";
import type { RiskVerdict } from "../reviewer/risk-classifier.js";
import {
  isJudgeCategory,
  isSameOrStricter,
  JudgeContractError,
  JudgeFailure,
  type JudgeDecision,
  type JudgeDiagnostics,
  type JudgeFailureKind,
  type JudgeRequest,
  type JudgeVerdict,
  type PermissionJudge,
  type RedactedJudgeRequest,
} from "./judge-contract.js";
import type { JudgeCircuitBreaker } from "./judge-breaker.js";
import { judgeArgsHash, redactJudgeRequest, redactJudgeText } from "./judge-redaction.js";
import { formatJudgeModel, type JudgeMode, type JudgeSettings, type JudgeStageSettings } from "./judge-settings.js";

type PriorRuleDecision = "allow" | "ask" | "deny" | "undecided";

// What the layers before the judge concluded about this call.
export interface JudgeGate {
  // The host already selected its ordinary reviewer lane; category switches
  // configure optional stages, not whether that baseline may review the call.
  reviewerBaseline?: boolean;
  // Outcome of floors + user rules + mode matrix; the judge runs only on `undecided`.
  priorDecision: PriorRuleDecision;
  strictMode: boolean;
  // Plugin or agent capability grant — never judge-decidable.
  capabilityGrant: boolean;
  // Request raised by a remote controller — never judge-decidable.
  remoteController: boolean;
}

type BeforeJudgeResult =
  // `redactInputKeys`: tool-input keys whose values the JUDGE sees as POLICY_REDACTED. Redaction is the only change a hook can make: the call that executes, its cwd, rule verdict and policy are never altered, and the audit row (argsHash, redactedRequest) always describes the real call.
  | { action: "continue"; redactInputKeys?: readonly string[] }
  | { action: "short-circuit"; decision: "ask" | "deny"; reason: string; fallback?: JudgeFailureKind };

type AfterJudgeResult = JudgeDecision | {
  decision: JudgeDecision;
  rationale: string;
  fallback?: JudgeFailureKind;
};

// What a judge sees in place of a value a beforeJudge hook redacted.
export const POLICY_REDACTED = "[redacted by policy]";

export interface JudgeHooks {
  // May hide input values from the judge or short-circuit to ask/deny. It receives a copy; mutating it has no effect on the call or the judge.
  beforeJudge?(request: Readonly<JudgeRequest>): BeforeJudgeResult | Promise<BeforeJudgeResult>;
  // May only keep or downgrade the verdict (allow → ask → deny).
  afterJudge?(verdict: JudgeVerdict, request: JudgeRequest): AfterJudgeResult | Promise<AfterJudgeResult>;
}

// One configured stage and its provider; `judge` null = could not be constructed (→ `unavailable`).
export interface JudgeChainStage {
  settings: JudgeStageSettings;
  judge: PermissionJudge | null;
}

export interface JudgeEngineDeps {
  // The implicit builtin reviewer retains its classifier's timeout/retry policy.
  // Configured chains use the user's stage and whole-chain budgets.
  budget?: "configured" | "classifier";
  settings: JudgeSettings;
  // Constructed stages, in `settings.chain` order. Empty is off unless rejected.
  chain: readonly JudgeChainStage[];
  // A rejected configured chain is unavailable, rather than an explicit off.
  chainRejected?: boolean;
  // Unreadable policy cannot establish off or shadow intent.
  settingsUnreadable?: boolean;
  breaker: JudgeCircuitBreaker;
  // Shadow rows go to the plain shadow channel; active decisions go to the HMAC-chained permission audit channel and fail the call if it cannot be written.
  audit: Pick<AuditLogger, "logShadow" | "appendPermissionAuditEntry">;
  hooks?: JudgeHooks;
  now?: () => number;
}

type JudgeSkipReason =
  | "judge-off"
  | "rule-decided"
  | "strict-mode"
  | "capability-grant"
  | "remote-controller"
  | "category-not-judged"
  | "category-disabled"
  | "breaker-open";

type JudgeOutcomeSource = "judge" | "hook" | "fallback" | "breaker";

export interface JudgeAuditRecord {
  event: "permission-judge";
  ts: string;
  session: string;
  invocationId: string;
  lane: JudgeRequest["lane"];
  mode: JudgeMode;
  tool: string;
  category: string;
  argsHash: string;
  redactedRequest: RedactedJudgeRequest;
  // The stage whose verdict ended the chain; null when the chain fell back.
  judge: { id: string; version: string } | null;
  // That stage's effective verdict (`ask` when it was still ambiguous); null on fallback.
  verdictDecision: JudgeDecision | null;
  // Every stage that ran, in order.
  stages: JudgeStageRecord[];
  // Decision after hooks, lanes and fallbacks.
  decision: JudgeDecision;
  applied: boolean;
  source: JudgeOutcomeSource;
  rationale: string;
  latencyMs: number;
  fallback: JudgeFailureKind | null;
  breakerTripped: boolean;
  pause?: "consecutive" | "total";
  // Input keys a beforeJudge hook hid from the judge.
  policyRedactedKeys?: string[];
}

interface JudgeStageRecord {
  id: string;
  provider: JudgeStageSettings["provider"];
  version: string | null;
  // `<provider>/<model>` for builtin-llm (configured, else the resolved reviewer model); null for external or unresolved.
  model: string | null;
  decision: JudgeDecision | null;
  confidence: number | null;
  escalateBelow: number | null;
  latencyMs: number;
  // decided = ended the chain; escalated = ambiguous; failed = no verdict; skipped = chain deadline already spent.
  outcome: "decided" | "escalated" | "failed" | "skipped";
  fallback: JudgeFailureKind | null;
  // Redacted, truncated provider stderr (external command judges).
  stderr?: string;
}

export type JudgeOutcome =
  | { judged: false; skip: JudgeSkipReason }
  | {
      judged: true;
      mode: JudgeMode;
      decision: JudgeDecision;
      // False in shadow mode: the caller must keep its pre-judge path.
      applied: boolean;
      // The caller may retain a redacted history summary, never an approval.
      recentlyDenied?: { verdict: RiskVerdict; inputSummary: string };
      source: JudgeOutcomeSource;
      // Stage id whose verdict ended the chain.
      decidedBy?: string;
      fallback?: JudgeFailureKind;
      // Rule the dock MAY offer; never persisted by the engine.
      suggestedRule?: string;
      rationale: string;
      breakerTripped: boolean;
      pause?: "consecutive" | "total";
    };

function skipReason(gate: JudgeGate, request: JudgeRequest, deps: JudgeEngineDeps): JudgeSkipReason | null {
  if (deps.chain.length === 0 && !deps.chainRejected && !deps.settingsUnreadable) return "judge-off";
  if (gate.priorDecision !== "undecided") return "rule-decided";
  if (gate.strictMode) return "strict-mode";
  if (gate.capabilityGrant) return "capability-grant";
  if (gate.remoteController) return "remote-controller";
  const category = request.invocation.category;
  if (!gate.reviewerBaseline && !isJudgeCategory(category)) return "category-not-judged";
  if (!gate.reviewerBaseline && isJudgeCategory(category) && !deps.settingsUnreadable && !deps.settings.categories[category]) return "category-disabled";
  if (!deps.chainRejected && !deps.settingsUnreadable && deps.breaker.isOpen(request.sessionId)) return "breaker-open";
  return null;
}

// The judge's view of the call: the real request with policy-redacted input values.
function judgeView(request: JudgeRequest, redactInputKeys: readonly string[] | undefined): JudgeRequest {
  if (!redactInputKeys || redactInputKeys.length === 0) return request;
  const input = request.invocation.finalInput;
  for (const key of redactInputKeys) {
    if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(input, key)) {
      throw new JudgeContractError(`beforeJudge redactInputKeys names an input key the call does not have: ${String(key)}`);
    }
  }
  const finalInput: Record<string, unknown> = { ...input };
  for (const key of redactInputKeys) finalInput[key] = POLICY_REDACTED;
  return { ...request, invocation: { ...request.invocation, finalInput } };
}

interface JudgeRun {
  verdict?: JudgeVerdict;
  fallback?: JudgeFailureKind;
  failureMessage?: string;
  diagnostics?: JudgeDiagnostics;
  // The engine's own timer fired (the stage budget it was given ran out), as opposed to a provider that reported a `timeout` failure on its own.
  engineTimedOut?: true;
}

async function runJudge(
  judge: PermissionJudge | null,
  request: JudgeRequest,
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<JudgeRun> {
  // A caller that already cancelled gets its cancel back; the judge is never started.
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (!judge) return { fallback: "unavailable", failureMessage: "judge provider unavailable" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new JudgeFailure("timeout", `judge timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
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
    if (timedOut) return { fallback: "timeout", failureMessage: `judge timed out after ${timeoutMs}ms`, engineTimedOut: true };
    if (err instanceof JudgeContractError) throw err;
    if (err instanceof JudgeFailure) {
      return { fallback: err.kind, failureMessage: err.message, ...(err.diagnostics ? { diagnostics: err.diagnostics } : {}) };
    }
    return { fallback: "error", failureMessage: errorMessage(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function chainDeadlineFallback(deps: JudgeEngineDeps): ChainResult {
  return {
    kind: "fallback",
    fallback: "timeout",
    failureMessage: `judge chain exceeded its ${deps.settings.chainDeadlineMs}ms deadline`,
  };
}

type ChainResult =
  | { kind: "verdict"; stage: JudgeChainStage; verdict: JudgeVerdict }
  | { kind: "fallback"; fallback: JudgeFailureKind; failureMessage: string };

// The model a stage actually ran: the configured one, else the provider's resolved model.
function stageModel(stage: JudgeChainStage): string | null {
  if (stage.settings.provider !== "builtin-llm") return null;
  return stage.settings.model ? formatJudgeModel(stage.settings.model) : stage.judge?.model ?? null;
}

// True when the verdict is final for its stage: allow/deny meeting the stage threshold.
function isFinalVerdict(stage: JudgeStageSettings, verdict: JudgeVerdict): boolean {
  if (verdict.decision === "ask") return false;
  if (stage.escalateBelow === undefined) return true;
  return verdict.confidence !== undefined && verdict.confidence >= stage.escalateBelow;
}

async function runChain(
  deps: JudgeEngineDeps,
  view: JudgeRequest,
  signal: AbortSignal | undefined,
  now: () => number,
  records: JudgeStageRecord[],
): Promise<ChainResult> {
  let lastFailure: JudgeRun | undefined;
  let ambiguous: { stage: JudgeChainStage; verdict: JudgeVerdict } | undefined;
  const deadline = deps.budget === "classifier" ? undefined : now() + deps.settings.chainDeadlineMs;
  for (let i = 0; i < deps.chain.length; i++) {
    const stage = deps.chain[i]!;
    const isLast = i === deps.chain.length - 1;
    const t0 = now();
    const remaining = deadline === undefined ? undefined : deadline - t0;
    if (remaining !== undefined && remaining <= 0) {
      for (const rest of deps.chain.slice(i)) {
        records.push({
          id: rest.settings.id, provider: rest.settings.provider, version: rest.judge?.version ?? null,
          model: stageModel(rest), escalateBelow: rest.settings.escalateBelow ?? null, latencyMs: 0,
          decision: null, confidence: null, outcome: "skipped", fallback: "timeout",
        });
      }
      return chainDeadlineFallback(deps);
    }
    const stageTimeout = remaining === undefined ? undefined : Math.min(deps.settings.timeoutMs, remaining);
    const run = await runJudge(stage.judge, view, stageTimeout, signal);
    const latencyMs = Math.max(0, now() - t0);
    const stderr = run.diagnostics?.stderr ?? run.verdict?.diagnostics?.stderr;
    const base = {
      id: stage.settings.id,
      provider: stage.settings.provider,
      version: stage.judge?.version ?? null,
      model: stageModel(stage),
      escalateBelow: stage.settings.escalateBelow ?? null,
      latencyMs,
      ...(stderr ? { stderr: redactJudgeText(stderr, 4_096) } : {}),
    };
    if (!run.verdict) {
      records.push({ ...base, decision: null, confidence: null, outcome: "failed", fallback: run.fallback ?? "error" });
      // The engine's timer fired on a budget the chain deadline capped: the deadline is spent and no later stage gets to run. A provider that reports its own timeout is an ordinary stage failure and escalates.
      if (run.engineTimedOut && stageTimeout !== undefined && stageTimeout < deps.settings.timeoutMs) {
        for (const rest of deps.chain.slice(i + 1)) {
          records.push({
            id: rest.settings.id, provider: rest.settings.provider, version: rest.judge?.version ?? null,
            model: stageModel(rest), escalateBelow: rest.settings.escalateBelow ?? null, latencyMs: 0,
            decision: null, confidence: null, outcome: "skipped", fallback: "timeout",
          });
        }
        return chainDeadlineFallback(deps);
      }
      lastFailure = run;
      ambiguous = undefined;
      continue;
    }
    const final = isFinalVerdict(stage.settings, run.verdict);
    records.push({
      ...base,
      decision: run.verdict.decision,
      confidence: run.verdict.confidence ?? null,
      outcome: final ? "decided" : "escalated",
      fallback: null,
    });
    if (final) return { kind: "verdict", stage, verdict: run.verdict };
    ambiguous = { stage, verdict: run.verdict };
    lastFailure = undefined;
    if (isLast) break;
  }
  if (ambiguous) {
    // The last stage was still unsure: the user decides.
    return { kind: "verdict", stage: ambiguous.stage, verdict: { ...ambiguous.verdict, decision: "ask" } };
  }
  return {
    kind: "fallback",
    fallback: lastFailure?.fallback ?? "error",
    failureMessage: lastFailure?.failureMessage ?? "judge failed",
  };
}

async function writeAudit(deps: JudgeEngineDeps, request: JudgeRequest, record: JudgeAuditRecord): Promise<void> {
  if (!record.applied) {
    deps.audit.logShadow({
      timestamp: record.ts,
      sessionId: record.session,
      type: "info",
      input: `permission-judge ${record.tool} decision=${record.decision} applied=false`,
      output: JSON.stringify(record),
    });
    return;
  }
  await deps.audit.appendPermissionAuditEntry({
    decision: "judge",
    ts: record.ts,
    auditId: randomUUID(),
    trustOrigin: request.invocation.trustOrigin,
    tool: request.invocation.toolName,
    source: request.invocation.source,
    category: request.invocation.category,
    judgeRecord: record,
  });
}

// Decide what the judge contributes to one tool call. Returns `judged: false` when the judge must not run; the caller then continues exactly as without a judge. Throws only for internal contract violations or a caller abort.
export async function resolveJudge(
  gate: JudgeGate,
  request: JudgeRequest,
  deps: JudgeEngineDeps,
  signal?: AbortSignal,
): Promise<JudgeOutcome> {
  if (deps.budget !== undefined && deps.budget !== "configured" && deps.budget !== "classifier") {
    throw new JudgeContractError("Invalid judge execution budget policy");
  }
  if (deps.budget === "classifier" &&
      (deps.chain.length !== 1 || deps.chain[0]?.settings.provider !== "builtin-llm")) {
    throw new JudgeContractError("Classifier execution budget requires one builtin reviewer stage");
  }
  const skip = skipReason(gate, request, deps);
  if (skip && skip !== "breaker-open") return { judged: false, skip };
  if (signal?.aborted) throw signal.reason;
  let pause = skip === "breaker-open" ? deps.breaker.pauseReason(request.sessionId) : undefined;

  const now = deps.now ?? Date.now;
  const started = now();
  const mode = deps.settingsUnreadable ? "active" : deps.settings.mode;
  let redactedKeys: readonly string[] = [];
  let source: JudgeOutcomeSource;
  let verdict: JudgeVerdict | undefined;
  let decidedBy: JudgeChainStage | undefined;
  let fallback: JudgeFailureKind | undefined;
  let decision: JudgeDecision;
  let rationale: string;
  const stages: JudgeStageRecord[] = [];

  const before: BeforeJudgeResult = pause
    ? { action: "short-circuit", decision: "ask", reason: `Automated approval paused: ${pause === "consecutive" ? "3 consecutive" : "20 total"} classifier blocks` }
    : deps.hooks?.beforeJudge
    ? await deps.hooks.beforeJudge(structuredClone(request))
    : { action: "continue" };
  if (before.action === "short-circuit") {
    if (before.decision !== "ask" && before.decision !== "deny") {
      throw new JudgeContractError("beforeJudge may only short-circuit to ask or deny");
    }
    source = pause ? "breaker" : before.fallback ? "fallback" : "hook";
    fallback = before.fallback;
    decision = before.decision;
    rationale = before.reason;
  } else {
    if (before.action !== "continue") {
      throw new JudgeContractError("beforeJudge must return continue or short-circuit");
    }
    redactedKeys = before.redactInputKeys ?? [];
    const view = judgeView(request, redactedKeys);
    const unavailable = deps.chainRejected || deps.settingsUnreadable;
    if (unavailable && signal?.aborted) throw signal.reason;
    const chain = unavailable
      ? { kind: "fallback" as const, fallback: "unavailable" as const,
          failureMessage: deps.settingsUnreadable ? "Permission judge settings cannot be read" : "Permission judge configuration is invalid" }
      : await runChain(deps, view, signal, now, stages);
    if (chain.kind === "verdict") {
      source = "judge";
      decidedBy = chain.stage;
      verdict = chain.verdict;
      decision = verdict.decision;
      rationale = verdict.rationale;
      if (deps.hooks?.afterJudge) {
        const result = await deps.hooks.afterJudge(verdict, request);
        const after = typeof result === "string" ? result : result.decision;
        if (!isSameOrStricter(verdict.decision, after)) {
          throw new JudgeContractError(`afterJudge may only downgrade (got ${verdict.decision} → ${String(after)})`);
        }
        decision = after;
        if (typeof result !== "string") {
          rationale = result.rationale;
          if (result.fallback) {
            if (after === "allow") throw new JudgeContractError("afterJudge failure must not allow");
            fallback = result.fallback;
            source = "fallback";
          }
        }
      }
    } else {
      source = "fallback";
      fallback = chain.fallback;
      decision = "ask";
      rationale = chain.failureMessage;
    }
  }

  if (signal?.aborted) throw signal.reason;
  const headless = request.lane === "headless";
  if (headless && decision === "ask") decision = "deny";
  const applied = mode === "active";
  // Shadow never changes behavior or creates denial history.

  let breakerTripped = false;
  if (applied && source === "judge" && verdict) {
    // One counter per session across the whole chain: the chain's final verdict.
    breakerTripped = deps.breaker.record(request.sessionId, verdict.decision, request.invocationId);
    pause = deps.breaker.pauseReason(request.sessionId);
    if (pause) {
      source = "breaker";
      decision = headless ? "deny" : "ask";
      rationale = `Automated approval paused: ${pause === "consecutive" ? "3 consecutive" : "20 total"} classifier blocks`;
    }
  }
  const deniedWithoutApprover = applied && headless && decision !== "allow";

  // The audit always describes the call that executes, not the judge's view.
  const redacted = redactJudgeRequest(request);
  const safeRationale = redactJudgeText(rationale, 2_000);
  await writeAudit(deps, request, {
    event: "permission-judge",
    ts: new Date(started).toISOString(),
    session: request.sessionId,
    invocationId: request.invocationId,
    lane: request.lane,
    mode,
    tool: request.invocation.toolName,
    category: request.invocation.category,
    argsHash: judgeArgsHash(redacted),
    redactedRequest: redacted,
    judge: decidedBy ? { id: decidedBy.settings.id, version: decidedBy.judge?.version ?? "unknown" } : null,
    verdictDecision: verdict?.decision ?? null,
    stages,
    decision,
    applied,
    source,
    rationale: safeRationale,
    latencyMs: Math.max(0, now() - started),
    fallback: fallback ?? null,
    breakerTripped,
    ...(pause ? { pause } : {}),
    ...(redactedKeys.length > 0 ? { policyRedactedKeys: [...redactedKeys] } : {}),
  });
  if (signal?.aborted) throw signal.reason;

  // A sibling review can trip the shared breaker while this call awaits its
  // audit write. Publish a recorded pause instead of a stale automatic allow.
  if (applied && source === "judge" && deps.breaker.isOpen(request.sessionId)) {
    return resolveJudge(gate, request, deps, signal);
  }

  return {
    judged: true,
    mode,
    decision,
    applied,
    ...(deniedWithoutApprover
      ? {
          recentlyDenied: {
            verdict: { level: "high", reason: `judge ${source}: ${safeRationale}` },
            inputSummary: JSON.stringify(redacted.tool.input).slice(0, 2_000),
          },
        }
      : {}),
    source,
    ...(decidedBy ? { decidedBy: decidedBy.settings.id } : {}),
    ...(fallback ? { fallback } : {}),
    ...(verdict?.suggestedRule ? { suggestedRule: verdict.suggestedRule } : {}),
    rationale: deniedWithoutApprover ? NO_APPROVER_MESSAGE : safeRationale,
    breakerTripped,
    ...(pause ? { pause } : {}),
  };
}
