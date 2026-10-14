/**
 * Judge engine — placement, tiered chain, hooks, fallbacks, circuit breaker and
 * audit for one tool call. Pure with respect to permission state: it reads the rule outcome
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
 * Chain: stages run in order. A stage's `allow`/`deny` whose confidence meets
 * its `escalateBelow` threshold (or that has no threshold) is final. A stage's
 * `ask`, a confidence below the threshold (a missing confidence counts as
 * below), or a stage failure escalates to the next stage. When the last stage
 * is still ambiguous the call goes to the dock (`ask`).
 *
 * Fallbacks: a stage failure (timeout, error, unparseable, unavailable) is
 * never an allow. When the LAST stage fails, the engine falls back to `ask` in
 * the foreground and `deny` + defer headless. Timeouts are tagged apart and,
 * like every fallback, never count toward the breaker. The breaker counts the
 * chain's final denials per session, whichever stage made them.
 *
 * `shadow` mode runs the whole chain and audits it, but `applied` is false:
 * the caller keeps today's path and the user still decides.
 */
import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../../audit/audit-logger.js";
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
  /**
   * `redactInputKeys`: tool-input keys whose values the JUDGE sees as
   * {@link POLICY_REDACTED}. Redaction is the only change a hook can make: the
   * call that executes, its cwd, rule verdict and policy are never altered, and
   * the audit row (argsHash, redactedRequest) always describes the real call.
   */
  | { action: "continue"; redactInputKeys?: readonly string[] }
  | { action: "short-circuit"; decision: "ask" | "deny"; reason: string };

/** What a judge sees in place of a value a beforeJudge hook redacted. */
export const POLICY_REDACTED = "[redacted by policy]";

export interface JudgeHooks {
  /**
   * May hide input values from the judge or short-circuit to ask/deny. It
   * receives a copy; mutating it has no effect on the call or the judge.
   */
  beforeJudge?(request: Readonly<JudgeRequest>): BeforeJudgeResult | Promise<BeforeJudgeResult>;
  /** May only keep or downgrade the verdict (allow → ask → deny). */
  afterJudge?(verdict: JudgeVerdict, request: JudgeRequest): JudgeDecision | Promise<JudgeDecision>;
}

/** One configured stage and its provider; `judge` null = could not be constructed (→ `unavailable`). */
export interface JudgeChainStage {
  settings: JudgeStageSettings;
  judge: PermissionJudge | null;
}

export interface JudgeEngineDeps {
  settings: JudgeSettings;
  /** Constructed stages, in `settings.chain` order. Empty = judge off. */
  chain: readonly JudgeChainStage[];
  breaker: JudgeCircuitBreaker;
  /**
   * Shadow rows go to the plain shadow channel; active decisions go to the
   * HMAC-chained permission audit channel and fail the call if it cannot be
   * written.
   */
  audit: Pick<AuditLogger, "logShadow" | "appendPermissionAuditEntry">;
  hooks?: JudgeHooks;
  now?: () => number;
}

export type JudgeSkipReason =
  | "judge-off"
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
  /** The stage whose verdict ended the chain; null when the chain fell back. */
  judge: { id: string; version: string } | null;
  /** That stage's effective verdict (`ask` when it was still ambiguous); null on fallback. */
  verdictDecision: JudgeDecision | null;
  /** Every stage that ran, in order. */
  stages: JudgeStageRecord[];
  /** Decision after hooks, lanes and fallbacks. */
  decision: JudgeDecision;
  applied: boolean;
  source: JudgeOutcomeSource;
  rationale: string;
  latencyMs: number;
  fallback: JudgeFailureKind | null;
  breakerTripped: boolean;
  /** Input keys a beforeJudge hook hid from the judge. */
  policyRedactedKeys?: string[];
}

export interface JudgeStageRecord {
  id: string;
  provider: JudgeStageSettings["provider"];
  version: string | null;
  /** `<provider>/<model>` for builtin-llm; `reviewer-default` when unset; null for external. */
  model: string | null;
  decision: JudgeDecision | null;
  confidence: number | null;
  escalateBelow: number | null;
  latencyMs: number;
  /** decided = ended the chain; escalated = ambiguous; failed = no verdict. */
  outcome: "decided" | "escalated" | "failed";
  fallback: JudgeFailureKind | null;
  /** Redacted, truncated provider stderr (external command judges). */
  stderr?: string;
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
      /** Stage id whose verdict ended the chain. */
      decidedBy?: string;
      fallback?: JudgeFailureKind;
      /** Rule the dock MAY offer; never persisted by the engine. */
      suggestedRule?: string;
      rationale: string;
      breakerTripped: boolean;
    };

function skipReason(gate: JudgeGate, request: JudgeRequest, deps: JudgeEngineDeps): JudgeSkipReason | null {
  if (deps.chain.length === 0) return "judge-off";
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

/** The judge's view of the call: the real request with policy-redacted input values. */
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
}

async function runJudge(
  judge: PermissionJudge | null,
  request: JudgeRequest,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<JudgeRun> {
  // A caller that already cancelled gets its cancel back; the judge is never started.
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (!judge) return { fallback: "unavailable", failureMessage: "judge provider unavailable" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
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
    if (timedOut) return { fallback: "timeout", failureMessage: `judge timed out after ${timeoutMs}ms` };
    if (err instanceof JudgeContractError) throw err;
    if (err instanceof JudgeFailure) {
      return { fallback: err.kind, failureMessage: err.message, ...(err.diagnostics ? { diagnostics: err.diagnostics } : {}) };
    }
    return { fallback: "error", failureMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

type ChainResult =
  | { kind: "verdict"; stage: JudgeChainStage; verdict: JudgeVerdict }
  | { kind: "fallback"; fallback: JudgeFailureKind; failureMessage: string };

function stageModel(stage: JudgeStageSettings): string | null {
  if (stage.provider !== "builtin-llm") return null;
  return stage.model ? formatJudgeModel(stage.model) : "reviewer-default";
}

/** True when the verdict is final for its stage: allow/deny meeting the stage threshold. */
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
  for (let i = 0; i < deps.chain.length; i++) {
    const stage = deps.chain[i]!;
    const isLast = i === deps.chain.length - 1;
    const t0 = now();
    const run = await runJudge(stage.judge, view, deps.settings.timeoutMs, signal);
    const latencyMs = Math.max(0, now() - t0);
    const stderr = run.diagnostics?.stderr ?? run.verdict?.diagnostics?.stderr;
    const base = {
      id: stage.settings.id,
      provider: stage.settings.provider,
      version: stage.judge?.version ?? null,
      model: stageModel(stage.settings),
      escalateBelow: stage.settings.escalateBelow ?? null,
      latencyMs,
      ...(stderr ? { stderr: redactJudgeText(stderr, 4_096) } : {}),
    };
    if (!run.verdict) {
      records.push({ ...base, decision: null, confidence: null, outcome: "failed", fallback: run.fallback ?? "error" });
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
  let redactedKeys: readonly string[] = [];
  let source: JudgeOutcomeSource;
  let verdict: JudgeVerdict | undefined;
  let decidedBy: JudgeChainStage | undefined;
  let fallback: JudgeFailureKind | undefined;
  let decision: JudgeDecision;
  let rationale: string;
  const stages: JudgeStageRecord[] = [];

  const before: BeforeJudgeResult = deps.hooks?.beforeJudge
    ? await deps.hooks.beforeJudge(structuredClone(request))
    : { action: "continue" };
  if (before.action === "short-circuit") {
    if (before.decision !== "ask" && before.decision !== "deny") {
      throw new JudgeContractError("beforeJudge may only short-circuit to ask or deny");
    }
    source = "hook";
    decision = before.decision;
    rationale = before.reason;
  } else {
    if (before.action !== "continue") {
      throw new JudgeContractError("beforeJudge must return continue or short-circuit");
    }
    redactedKeys = before.redactInputKeys ?? [];
    const view = judgeView(request, redactedKeys);
    const chain = await runChain(deps, view, signal, now, stages);
    if (chain.kind === "verdict") {
      source = "judge";
      decidedBy = chain.stage;
      verdict = chain.verdict;
      decision = verdict.decision;
      rationale = verdict.rationale;
      if (deps.hooks?.afterJudge) {
        const after = await deps.hooks.afterJudge(verdict, request);
        if (!isSameOrStricter(verdict.decision, after)) {
          throw new JudgeContractError(`afterJudge may only downgrade (got ${verdict.decision} → ${String(after)})`);
        }
        decision = after;
      }
    } else {
      source = "fallback";
      fallback = chain.fallback;
      decision = "ask";
      rationale = chain.failureMessage;
    }
  }

  const headless = request.lane === "headless";
  if (headless && decision === "ask") decision = "deny";
  const applied = mode === "active";
  // Shadow must never change behavior, so it never asks the call site to defer.
  const defer = applied && headless && decision !== "allow";

  let breakerTripped = false;
  if (applied && source === "judge" && verdict) {
    // One counter per session across the whole chain: the chain's final verdict.
    breakerTripped = deps.breaker.record(request.sessionId, verdict.decision);
  }

  // The audit always describes the call that executes, not the judge's view.
  const redacted = redactJudgeRequest(request);
  const safeRationale = redactJudgeText(rationale, 2_000);
  await writeAudit(deps, request, {
    event: "permission-judge",
    ts: new Date(started).toISOString(),
    session: request.sessionId,
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
    ...(redactedKeys.length > 0 ? { policyRedactedKeys: [...redactedKeys] } : {}),
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
    ...(decidedBy ? { decidedBy: decidedBy.settings.id } : {}),
    ...(fallback ? { fallback } : {}),
    ...(verdict?.suggestedRule ? { suggestedRule: verdict.suggestedRule } : {}),
    rationale: safeRationale,
    breakerTripped,
  };
}
