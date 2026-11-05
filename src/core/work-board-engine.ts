/** Sequence isolated plan and execution children around the user's work approval of each plan; persist their output and execution session
 * id on the board. The approval is a decision stored on the item (permission-decision-tree.md "Work approvals"), not a tool-approval card. */
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { updateApprovalSurface } from "../permissions/approval-surface-registry.js";
import {
  exactToolScope,
  PARENT_ALL_TOOL_SCOPE,
  type SubAgentRunner,
} from "../engine/subagent-runner.js";
import type { LoadedAgentProfile } from "../main/agent-profile-store.js";
import { itemDigestOf, type WorkBoardStore } from "../main/work-board-store.js";
import type {
  WorkItem,
  WorkItemResolved,
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkBoardRunEvent,
  WorkBoardCancelResult,
  WorkBoardRunToolStep,
  WorkBoardSteerAck,
  WorkBoardSteerResult,
  WorkProposalInput,
  WorkPlanApprovalStatus,
  WorkPlanDecideRefusal,
  WorkPlanDecideResult,
  WorkPlanDecision,
} from "../shared/work-board-types.js";
import {
  MAX_PLAN_NOTE_LENGTH,
  BRIEFING_PROPOSAL_KINDS,
  MAX_PROPOSAL_BLOCKERS,
  MAX_PROPOSAL_EVIDENCE,
  PROPOSAL_KEY_MAX,
  workBoardOriginSessionId,
} from "../shared/work-board-types.js";
import { createLogger } from "../lib/logger.js";
import {
  createRunTranscript,
  type TranscriptStorage,
  type RunTranscriptWriter,
} from "../work-board/run-transcript.js";
import type { SubAgentActivityUpdate } from "../engine/subagent-runner.js";
import { toolStepsOf, toolStepsSignature } from "../work-board/tool-steps.js";
import { errorMessage } from "../shared/error-message.js";
import { requiredTier } from "../permissions/permission-manager.js";
import { formatPlanRevisionDirective, hasUnsafeDirectiveControlChars } from "../engine/parent-directive.js";
import type { ToolRegistry } from "../tools/registry.js";

const log = createLogger("work-board-engine");

/** Use completed assistant-round counts; turn zero contains only in-flight activity and has no board narrative. */
function activityToTurn(u: SubAgentActivityUpdate): { turn: number; text: string } {
  let turn = 0;
  let text = "";
  for (const entry of u.entries) {
    if (entry.kind === "assistant" && entry.streaming !== true) {
      turn += 1;
      if (entry.text) text = entry.text;
    }
  }
  return { turn, text };
}

/** Record each completed round once per phase; repeated tool and streaming callbacks must not append blank or duplicate rows. The phase's
 * tool steps are reported whenever what the board shows of them changes, and each step is reported finished once. */
function makeActivityRecorder(handlers: {
  onTurn: (turn: number, text: string) => void;
  onTools: (steps: WorkBoardRunToolStep[]) => void;
  onToolFinished: (step: WorkBoardRunToolStep) => void;
}): { onActivity: (u: SubAgentActivityUpdate) => void; lastTurn: () => number } {
  let lastTurn = 0;
  let lastSignature = "";
  const finished = new Set<string>();
  return {
    onActivity: (u) => {
      const { turn, text } = activityToTurn(u);
      if (turn > lastTurn) {
        lastTurn = turn;
        handlers.onTurn(turn, text);
      }
      const steps = toolStepsOf(u.entries);
      const signature = toolStepsSignature(steps);
      if (signature !== lastSignature) {
        lastSignature = signature;
        handlers.onTools(steps);
      }
      for (const step of steps) {
        if (step.status === "running" || finished.has(step.toolUseId)) continue;
        finished.add(step.toolUseId);
        handlers.onToolFinished(step);
      }
    },
    lastTurn: () => lastTurn,
  };
}

/** Derive planning tools from static read-tier categories; input-dependent categories do not qualify. Execution explicitly receives parent-all, with agent_spawn stripped by the runner. */
const PLAN_TOOLS_EMPTY = "no read-tier tools are registered";

function planReadOnlyToolNames(registry: ToolRegistry): string[] {
  return registry
    .listAll()
    .filter((tool) => requiredTier(tool.category) === "read")
    .map((tool) => tool.name);
}

export interface WorkBoardEngineDeps {
  store: WorkBoardStore;
  /** The runner is unavailable until parent-loop construction; report early calls as errors. */
  getRunner: () => SubAgentRunner | undefined;
  /** A named profile's model applies to both child phases. */
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  emitProgress: (event: WorkBoardRunEvent) => void;
  /** Optional transcript storage retains context across restarts and reruns; absence skips persistence. */
  transcriptStorage?: TranscriptStorage;
  /** Invoke learning only after successful persistence; hook failures must not fail a completed run. */
  onRunComplete?: (info: { itemId: number; title: string; projectRoot?: string; projectName?: string }) => void | Promise<void>;
}

interface RunItemOptions {
  agentName?: string;
  /** Set by the host entrypoint, never copied from a renderer payload. */
  approvalSurface?: WebContents | null;
}

interface RunItemResult {
  /** awaiting_approval: the plan is stored with a pending decision and the run continues only through decidePlan. */
  status: "completed" | "awaiting_approval" | "denied" | "not_found" | "error" | "already_running" | "cancelled";
  output?: string;
  plan?: string;
  runSessionId?: string;
  /** Busy means another run owns the item and no second child was spawned. */
  reason?: string;
}

/** The user's decision on a stored plan, named by its run and the hash of the plan they saw; the plan text itself is never sent. */
interface DecidePlanInput {
  runId: string;
  planHash: string;
  decision: WorkPlanDecision;
  /** Already redacted by the caller; bounded and checked here. Required for request_changes. */
  note?: string;
}

interface DecidePlanOptions {
  /** Set by the host entrypoint: the window the execute (or re-plan) child's tool cards appear in. */
  approvalSurface?: WebContents | null;
}

interface DecidePlanOutcome {
  result: WorkPlanDecideResult;
  /** Present when the decision continues the run (approve executes, request_changes re-plans); settles with that phase's result. */
  continuation?: Promise<RunItemResult>;
}

export interface WorkBoardEngine {
  /** Combine in-process and persisted active-status guards per item; finished reruns start clean while preserving history. Returns
   * awaiting_approval once the plan is stored; nothing waits for the user here. */
  runItem(itemId: number, opts?: RunItemOptions): Promise<RunItemResult>;

  /** Record the user's work approval of the pending plan, then continue the run: approve executes it, request_changes re-plans the same
   * run with the note as fenced non-principal guidance, reject ends it as denied. A decision that does not match the stored pending plan
   * (another run, another plan, a changed item for approve) is refused and nothing runs. */
  decidePlan(itemId: number, input: DecidePlanInput, opts?: DecidePlanOptions): Promise<DecidePlanOutcome>;

  /** The execute child's session id while that child is linked and the run is still in flight; undefined in every other phase. */
  executingChildSessionId(itemId: number): string | undefined;

  /** Queue the local user's text for this item's execute child at its next round boundary. The child is the engine's own record, never a
   * caller-supplied id; the text enters as host-fenced non-principal guidance (permission-decision-tree.md S→T, "Delegated work"). */
  steerRun(itemId: number, text: string): WorkBoardSteerResult;

  /** Interrupt this item's execute child through the ordinary sub-agent cancellation path; the run settles as `cancelled`.
   * Planning and plan approval are not stoppable here and refuse as not-executing. */
  cancelRun(itemId: number): WorkBoardCancelResult;

  /** A read-only survey files proposals for user review without plan approval; individual tools remain gated. Allow only one survey per briefing window. */
  runBriefing(
    kind: WorkBoardBriefingKind,
    opts?: BriefingOptions,
  ): Promise<WorkBoardBriefingResult>;
}

interface BriefingOptions {
  projectRoot?: string;
  includeUnscoped?: boolean;
  /** A background survey explicitly has no interactive owner. */
  approvalSurface?: WebContents | null;
}

/** The host bounds planning rounds because autonomous runs cannot ask for answers; return the best plan at the cap. */
const PLAN_ROUND_BUDGET = 20;

function buildPlanPrompt(item: WorkItem): string {
  const detail = item.detail?.trim();
  return [
    `You are planning how to complete the following work item. You are running AUTONOMOUSLY: there is NO human available to answer questions during this run.`,
    ``,
    `Rules:`,
    `- Do NOT ask the user any questions and do NOT request clarification. If the request is ambiguous, pick the most reasonable interpretation, state that assumption explicitly in the plan, and proceed.`,
    `- Investigate briefly with read-only tools only if it materially helps (a few calls at most). If a tool errors, note it and move on — never retry in a loop.`,
    `- Make NO changes — this is the planning phase only.`,
    ``,
    `Work item #${item.id}: ${item.title}`,
    ...(detail ? [``, `Details:`, detail] : []),
    ``,
    `Respond with the PLAN as your final message: a concise, concrete, step-by-step plan with any assumptions called out under an "Assumptions" heading. The user reviews and approves this plan (and your assumptions) before execution — that approval is the only human checkpoint.`,
  ].join("\n");
}

/** A re-plan keeps the original planning rules and adds the prior plan and the user's change request as quoted host-fenced data. */
function buildRevisionPlanPrompt(item: WorkItem, priorPlan: string, note: string): string {
  return [buildPlanPrompt(item), ``, formatPlanRevisionDirective(priorPlan, note)].join("\n");
}

function buildExecutePrompt(item: WorkItem, plan: string): string {
  const detail = item.detail?.trim();
  return [
    `Execute the following work item according to the approved plan below. You are running AUTONOMOUSLY: do NOT ask the user any questions — proceed per the plan, and if something is ambiguous, act on the plan's stated assumptions (or the most reasonable one) and note it in your output. You have full tools available; each individual tool call is still independently approved by the user. If a tool errors, adapt or note it — never retry in a loop.`,
    ``,
    `Work item #${item.id}: ${item.title}`,
    ...(detail ? [``, `Details:`, detail] : []),
    ``,
    `Approved plan:`,
    plan,
    ``,
    `Carry out the plan and report the OUTCOME as your final message.`,
  ].join("\n");
}

/** Bound read-only briefing rounds so autonomous retries always converge to parsing. */
const BRIEFING_ROUND_BUDGET = 20;

/** Cap proposals per briefing so the survey must prioritize. */
const MAX_BRIEFING_ACTION_ITEMS = 8;

/** Expire daily findings after a day and weekly findings after a week. */
const BRIEFING_TTL_MS: Record<WorkBoardBriefingKind, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

const BRIEFING_WINDOW: Record<WorkBoardBriefingKind, string> = {
  daily: "today and the next working day",
  weekly: "the past week and the week ahead",
};

/** Deduplicate by normalized title; summary and evidence drift across surveys, while renamed work deliberately gets a new identity. */
function briefingKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, PROPOSAL_KEY_MAX)
    .trim();
}

function briefingBoardLine(item: WorkItemResolved): string {
  return `- [${item.status_resolved}] ${item.title}`;
}

/** Keep survey wording and output bounds host-owned; include the existing board to avoid duplicate proposals. */
function buildBriefingPrompt(
  kind: WorkBoardBriefingKind,
  openItems: readonly WorkItemResolved[],
): string {
  return [
    `You are running the user's ${kind} work briefing. You are running AUTONOMOUSLY: there is NO human available to answer questions during this run.`,
    ``,
    `Survey what the user is working on across ${BRIEFING_WINDOW[kind]} and report the action items that need their attention.`,
    ``,
    `Rules:`,
    `- Do NOT ask the user any questions and do NOT request clarification. If something is ambiguous, state the assumption inside the item you report and move on.`,
    `- Investigate with read-only tools only. Make NO changes of any kind.`,
    `- If a tool errors, note it and move on — never retry in a loop.`,
    `- Report at most ${MAX_BRIEFING_ACTION_ITEMS} items, highest-consequence first. Fewer is better than padded.`,
    `- Do NOT repeat anything already on the board (listed below).`,
    ``,
    `Already on the board:`,
    openItems.length > 0 ? openItems.map(briefingBoardLine).join("\n") : "- Nothing open.",
    ``,
    `Respond with ONLY a JSON array in a \`\`\`json fenced block, and no prose before or after it. Each element:`,
    `{`,
    `  "title": "one line naming the work",`,
    `  "summary": "one line saying why it needs attention",`,
    `  "state": "where this currently stands",`,
    `  "evidence": [{ "label": "what you looked at", "detail": "what it said" }],`,
    `  "blockers": [{ "reason": "what stops it", "resolution": "what would unblock it" }],`,
    `  "taskBrief": "instructions for an agent that will later carry this out",`,
    `  "priority": "high" | "medium" | "low"`,
    `}`,
    ``,
    `"evidence" and "blockers" may be empty arrays. If nothing needs the user's attention, respond with an empty array.`,
  ].join("\n");
}

/** An empty valid survey means no work; malformed output is a visible run failure. */
type BriefingParse =
  | { ok: true; items: WorkProposalInput[] }
  | { ok: false; reason: string };

function extractJsonArray(text: string): unknown[] | null {
  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
  const candidate = fenced?.[1] ?? /\[[\s\S]*\]/.exec(text)?.[0];
  if (candidate === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedRows<T>(value: unknown, max: number, map: (row: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const rows: T[] = [];
  for (const raw of value.slice(0, max)) {
    if (!raw || typeof raw !== "object") continue;
    const mapped = map(raw as Record<string, unknown>);
    if (mapped !== null) rows.push(mapped);
  }
  return rows;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Drop rows missing rendered fields rather than inventing survey findings; the store applies length caps. */
function parseBriefingActionItems(
  kind: WorkBoardBriefingKind,
  text: string,
): BriefingParse {
  const rows = extractJsonArray(text);
  if (rows === null) {
    return { ok: false, reason: "briefing output did not contain a JSON action-item array" };
  }

  const items: WorkProposalInput[] = [];
  for (const raw of rows.slice(0, MAX_BRIEFING_ACTION_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const title = nonEmptyString(row.title);
    const summary = nonEmptyString(row.summary);
    const state = nonEmptyString(row.state);
    const taskBrief = nonEmptyString(row.taskBrief);
    if (title === null || summary === null || state === null || taskBrief === null) {
      log.warn("briefing action item dropped — missing a required field");
      continue;
    }
    const key = briefingKey(title);
    if (key.length === 0) continue;
    // Omit unknown priorities so only normalizeProposalInput supplies defaults.
    const priority =
      row.priority === "high" || row.priority === "medium" || row.priority === "low"
        ? row.priority
        : undefined;
    items.push({
      kind: BRIEFING_PROPOSAL_KINDS[kind],
      key,
      title,
      summary,
      state,
      evidence: boundedRows(row.evidence, MAX_PROPOSAL_EVIDENCE, (e) => {
        const label = nonEmptyString(e.label);
        const detail = nonEmptyString(e.detail);
        return label !== null && detail !== null ? { label, detail } : null;
      }),
      blockers: boundedRows(row.blockers, MAX_PROPOSAL_BLOCKERS, (b) => {
        const reason = nonEmptyString(b.reason);
        if (reason === null) return null;
        const resolution = nonEmptyString(b.resolution);
        return resolution !== null ? { reason, resolution } : { reason };
      }),
      taskBrief,
      ...(priority !== undefined ? { priority } : {}),
      ttlMs: BRIEFING_TTL_MS[kind],
    });
  }
  return { ok: true, items };
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  "planning",
  "awaiting_approval",
  "executing",
]);

type PlanDecisionStatus = Exclude<WorkPlanApprovalStatus, "pending">;

const DECISION_STATUS: Record<WorkPlanDecision, PlanDecisionStatus> = {
  approve: "approved",
  reject: "rejected",
  request_changes: "changes_requested",
};

/** One run's transcript appends, serialized and drained before terminal returns; write failures never fail the run. */
interface RunRecorder {
  record: (e: Parameters<RunTranscriptWriter["append"]>[0]) => void;
  flush: () => Promise<void>;
}

/** What a plan phase needs: the first plan of a run, or a re-plan after the user asked for changes. */
interface PlanPhaseInput {
  itemId: number;
  item: WorkItem;
  runId: string;
  runner: SubAgentRunner;
  planTools: string[];
  profile: LoadedAgentProfile | null;
  agentName?: string;
  revision: number;
  /** Present on a re-plan: the plan the user sent back and their already-masked, bounded note. */
  revisionRequest?: { priorPlan: string; note: string };
  recorder: RunRecorder;
}

export function createWorkBoardEngine(
  deps: WorkBoardEngineDeps,
): WorkBoardEngine {
  const { store, getRunner, getAgentProfile, emitProgress, onRunComplete, transcriptStorage } =
    deps;

  /** Set the in-process guard before awaiting persisted status to close the duplicate-run race. */
  const inFlight = new Set<number>();
  // Items whose run has stored a pending plan but has not yet released the item (it is finishing the transcript).
  const planSettling = new Set<number>();

  /** Host-recorded execute child per item, set when the child links and removed when the run settles. Steer and stop resolve the child here, never from a renderer payload. */
  const executingChildByItem = new Map<number, string>();

  /** Items whose stop the user requested and the runner accepted. Only an interrupted result for such an item becomes `cancelled`; an
   * interruption the user did not ask for (workspace revocation, shutdown) stays an error. */
  const cancelRequested = new Set<number>();

  /** The execute child's finished-turn count per item, read when a steer reaches it. */
  const executingTurnByItem = new Map<number, () => number>();

  /** Allow one survey per window so duplicate clicks cannot incur duplicate child runs. */
  const briefingInFlight = new Set<WorkBoardBriefingKind>();

  const emit = (event: Omit<WorkBoardRunEvent, "at">): void => {
    emitProgress({ ...event, at: new Date().toISOString() });
  };

  function openRecorder(itemId: number, runId: string): RunRecorder {
    const transcript: RunTranscriptWriter | null = transcriptStorage
      ? createRunTranscript(transcriptStorage, itemId, runId)
      : null;
    let chain: Promise<void> = Promise.resolve();
    return {
      record: (e) => {
        if (!transcript) return;
        chain = chain
          .then(() => transcript.append(e))
          .catch((err) => log.warn("run transcript append failed (id=%d): %s", itemId, (err as Error).message));
      },
      flush: () => chain,
    };
  }

  /** Runs `body` as this item's one in-flight phase. The caller has already added the item to `inFlight` synchronously, so a concurrent
   * run or decision cannot slip in between its check and this call. The approval surface is attached for the phase's child tool cards. */
  async function guarded<T>(itemId: number, surface: WebContents | null | undefined, body: () => Promise<T>): Promise<T> {
    const originSessionId = workBoardOriginSessionId(itemId);
    updateApprovalSurface({ kind: "attach", sessionId: originSessionId, surface: surface ?? null });
    try {
      return await body();
    } finally {
      executingChildByItem.delete(itemId);
      executingTurnByItem.delete(itemId);
      cancelRequested.delete(itemId);
      planSettling.delete(itemId);
      inFlight.delete(itemId);
      updateApprovalSurface({ kind: "release", sessionId: originSessionId });
    }
  }

  async function runItem(
    itemId: number,
    opts: RunItemOptions = {},
  ): Promise<RunItemResult> {
    const got = await store.get(itemId);
    if (got.status !== "found") {
      return { status: "not_found" };
    }
    const item = got.item;

    if (inFlight.has(itemId) || ACTIVE_RUN_STATUSES.has(item.runStatus ?? "idle")) {
      return {
        status: "already_running",
        reason: `Work item #${itemId} is already running (runStatus=${item.runStatus ?? "idle"}).`,
      };
    }
    inFlight.add(itemId);
    return guarded(itemId, opts.approvalSurface, () => runItemGuarded(itemId, item, opts));
  }

  /** A named profile that no longer exists fails the run explicitly; no profile means the default model. */
  async function resolveProfile(agentName: string | undefined): Promise<{ ok: true; profile: LoadedAgentProfile | null } | { ok: false; reason: string }> {
    if (!agentName) return { ok: true, profile: null };
    const profile = (await getAgentProfile?.(agentName)) ?? null;
    return profile ? { ok: true, profile } : { ok: false, reason: `agent profile not found: ${agentName}` };
  }

  /** Settle the run as error from a thrown failure; the persist itself may fail and is only logged. */
  async function failRun(itemId: number, err: unknown, recorder: RunRecorder | null): Promise<RunItemResult> {
    const reason = errorMessage(err);
    log.warn("work-board run error (id=%d): %s", itemId, reason);
    await store
      .setRunResult(itemId, { runStatus: "error" })
      .catch((persistErr) =>
        log.warn("work-board run error-state persist failed (id=%d): %s", itemId, (persistErr as Error).message),
      );
    recorder?.record({ phase: "error", kind: "error", message: reason });
    emit({ itemId, phase: "error", message: reason });
    await recorder?.flush();
    return { status: "error", reason };
  }

  async function runItemGuarded(
    itemId: number,
    item: WorkItem,
    opts: RunItemOptions,
  ): Promise<RunItemResult> {
    const runner = getRunner();
    if (!runner) {
      // An unavailable late-bound runner is a wiring error, never a reason to fall back.
      await store.setRunResult(itemId, {
        runStatus: "error",
      });
      emit({ itemId, phase: "error", message: "sub-agent runner not available" });
      return { status: "error", reason: "sub-agent runner not available" };
    }

    const planTools = planReadOnlyToolNames(runner.parentToolRegistry());
    if (planTools.length === 0) {
      await store.setRunResult(itemId, { runStatus: "error" });
      emit({ itemId, phase: "error", message: PLAN_TOOLS_EMPTY });
      return { status: "error", reason: PLAN_TOOLS_EMPTY };
    }

    // Resolve one profile for both phases; missing named profiles fail explicitly.
    const resolved = await resolveProfile(opts.agentName);
    if (!resolved.ok) {
      await store.setRunResult(itemId, { runStatus: "error" });
      emit({ itemId, phase: "error", message: resolved.reason });
      return { status: "error", reason: resolved.reason };
    }

    const runId = randomUUID();
    const startedAt = new Date(Date.now()).toISOString();
    const recorder = openRecorder(itemId, runId);

    try {
      // Archive prior runs before resetting latest fields so denied reruns cannot display stale success.
      await store.beginRun(itemId, runId, startedAt);
      return await planPhase({
        itemId,
        item,
        runId,
        runner,
        planTools,
        profile: resolved.profile,
        ...(opts.agentName ? { agentName: opts.agentName } : {}),
        revision: 0,
        recorder,
      });
    } catch (err) {
      return failRun(itemId, err, recorder);
    }
  }

  /** Plan, then store the plan with its pending decision and return. Nothing waits here: the decision is a work approval the user makes
   * later through decidePlan (permission-decision-tree.md "Work approvals"), however long that takes and across restarts. */
  async function planPhase(input: PlanPhaseInput): Promise<RunItemResult> {
    const { itemId, item, runId, runner, planTools, profile, recorder } = input;
    emit({ itemId, phase: "planning" });
    // Persisted as it links, like the execute child: a board that mounts mid-plan (opened from the run's row) reads the child from the
    // listed item and can claim its tool approvals.
    let planLinkedPersist: Promise<{ failed: false } | { failed: true; error: unknown }> = Promise.resolve({ failed: false });
    const planResult = await runner.spawn(
      {
        title: `Plan: ${item.title}`,
        instructions: input.revisionRequest
          ? buildRevisionPlanPrompt(item, input.revisionRequest.priorPlan, input.revisionRequest.note)
          : buildPlanPrompt(item),
        toolScope: exactToolScope(planTools),
        originSessionId: workBoardOriginSessionId(itemId),
        ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
        profileMode: "plan",
        profileModel: profile?.model,
        maxRounds: PLAN_ROUND_BUDGET,
      },
      {
        // The planning child's session is reported as it links, like the execute child's: the board claims both children's tool
        // approvals, and a planning child can ask for one too.
        onLinked: ({ childSessionId }) => {
          emit({ itemId, phase: "planning", runSessionId: childSessionId });
          planLinkedPersist = store
            .setRunSessionId(itemId, childSessionId)
            .then(
              () => ({ failed: false as const }),
              (error: unknown) => ({ failed: true as const, error }),
            );
        },
        onActivity: makeActivityRecorder({
          onTurn: (turn, text) => {
            emit({ itemId, phase: "planning", turn, text });
            recorder.record({ phase: "planning", kind: "turn", turn, text });
          },
          onTools: (tools) => emit({ itemId, phase: "planning", tools }),
          onToolFinished: (tool) => recorder.record({ phase: "planning", kind: "tool", turn: tool.turn, tool }),
        }).onActivity,
        onError: (message) => emit({ itemId, phase: "error", message }),
      },
    );
    const planLinkOutcome = await planLinkedPersist;
    if (planLinkOutcome.failed) throw planLinkOutcome.error;
    // A failed plan child's summary is its error text, never a plan the user could approve.
    if (planResult.ok === false) {
      const reason = planResult.error ?? planResult.summary;
      log.warn("work-board plan failed (id=%d): %s", itemId, reason);
      await store.setRunResult(itemId, { runStatus: "error" });
      recorder.record({ phase: "error", kind: "error", message: reason });
      emit({ itemId, phase: "error", message: reason });
      await recorder.flush();
      return { status: "error", reason };
    }
    const plan = planResult.summary;
    recorder.record({ phase: "awaiting_approval", kind: "plan", text: plan });
    const stored = await store.setPlanAwaitingApproval(itemId, {
      runId,
      plan,
      runSessionId: planResult.childSessionId,
      revision: input.revision,
      // The item the prompt was built from: an edit made during planning makes this plan stale.
      itemDigest: itemDigestOf(item),
      ...(input.agentName ? { agentName: input.agentName } : {}),
    });
    if (stored === null || stored.status !== "updated") {
      throw new Error(`work item #${itemId} left run ${runId} while it was planning`);
    }
    planSettling.add(itemId);
    emit({ itemId, phase: "awaiting_approval" });
    await recorder.flush();
    return { status: "awaiting_approval", plan, runSessionId: planResult.childSessionId };
  }

  /** Run the approved plan. The decision is already stored and the run already marked executing; full execution scope still passes
   * every tool call through its own permission tree (CHILD → H). */
  async function executePhase(itemId: number, item: WorkItem, plan: string, profile: LoadedAgentProfile | null, runner: SubAgentRunner, recorder: RunRecorder): Promise<RunItemResult> {
    const originSessionId = workBoardOriginSessionId(itemId);
    emit({ itemId, phase: "executing" });

    // The plan child's id is stored until the execute child links; replace it then so an in-flight "open session" opens the execute session.
    // The store serializes writes per file, so this lands before the terminal result write below.
    // The write settles into a captured outcome so a rejection is never left unhandled while the child runs.
    let linkedPersist: Promise<{ failed: false } | { failed: true; error: unknown }> = Promise.resolve({ failed: false });
    const executeActivity = makeActivityRecorder({
      onTurn: (turn, text) => {
        emit({ itemId, phase: "executing", turn, text });
        recorder.record({ phase: "executing", kind: "turn", turn, text });
      },
      onTools: (tools) => emit({ itemId, phase: "executing", tools }),
      onToolFinished: (tool) => recorder.record({ phase: "executing", kind: "tool", turn: tool.turn, tool }),
    });
    // Which turn received a steer: read when the loop acknowledges the injection (see steerRun).
    executingTurnByItem.set(itemId, executeActivity.lastTurn);
    const execResult = await runner.spawn(
      {
        title: `Execute: ${item.title}`,
        instructions: buildExecutePrompt(item, plan),
        toolScope: PARENT_ALL_TOOL_SCOPE,
        originSessionId,
        ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
        profileMode: "execute",
        profileModel: profile?.model,
      },
      {
        onLinked: ({ childSessionId }) => {
          // The host's own record of this run's execute child: steer and stop resolve it here, never from renderer input.
          executingChildByItem.set(itemId, childSessionId);
          emit({ itemId, phase: "executing", runSessionId: childSessionId });
          linkedPersist = store
            .setRunSessionId(itemId, childSessionId)
            .then(
              () => ({ failed: false as const }),
              (error: unknown) => ({ failed: true as const, error }),
            );
        },
        onActivity: executeActivity.onActivity,
        // The runner reports some interrupted unwinds through onError; a stop the user asked for is not an error.
        onError: (message) => {
          if (!cancelRequested.has(itemId)) emit({ itemId, phase: "error", message });
        },
      },
    );
    // A failed link write is a store failure; surface it through the run's error path rather than dropping it, even if the child finished.
    const linkOutcome = await linkedPersist;
    if (linkOutcome.failed) throw linkOutcome.error;
    // A user stop settles as cancelled (owner decision 2026-11-04), checked before the generic failure branch.
    if (execResult.ok === false && execResult.stopReason === "interrupted" && cancelRequested.has(itemId)) {
      await store.setRunResult(itemId, { runStatus: "cancelled", plan });
      recorder.record({ phase: "cancelled", kind: "decision", message: "user-stopped" });
      emit({ itemId, phase: "cancelled", message: "user-stopped" });
      await recorder.flush();
      return { status: "cancelled", plan, reason: "user-stopped" };
    }
    // Treat ok:false as error, never as completed output containing the error summary.
    if (execResult.ok === false) {
      const reason = execResult.error ?? execResult.summary;
      log.warn("work-board execute failed (id=%d): %s", itemId, reason);
      await store.setRunResult(itemId, { runStatus: "error" });
      recorder.record({ phase: "error", kind: "error", message: reason });
      emit({ itemId, phase: "error", message: reason });
      await recorder.flush();
      return { status: "error", reason };
    }

    const output = execResult.summary;

    await store.setRunResult(itemId, {
      runStatus: "completed",
      plan,
      output,
      runSessionId: execResult.childSessionId,
    });
    recorder.record({ phase: "done", kind: "output", text: output });
    emit({
      itemId,
      phase: "done",
      runSessionId: execResult.childSessionId,
    });
    await recorder.flush();
    // Persist success before fire-and-forget learning; memory append failure must not change run status.
    if (onRunComplete) {
      // Invoke the hook inside then so synchronous throws also become caught rejections.
      void Promise.resolve()
        .then(() =>
          onRunComplete({
            itemId,
            title: item.title,
            ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
            ...(item.projectName ? { projectName: item.projectName } : {}),
          }),
        )
        .catch((e) =>
          log.warn("work-board onRunComplete failed (id=%d): %s", itemId, (e as Error).message),
        );
    }
    return {
      status: "completed",
      plan,
      output,
      runSessionId: execResult.childSessionId,
    };
  }

  /** Check the note against the decision before anything is stored: a change request needs one, and every note is bounded and free of
   * control characters. The caller has already applied outgoing PII redaction. */
  function noteRefusal(decision: WorkPlanDecision, note: string | undefined): WorkPlanDecideRefusal | null {
    if (note === undefined || note.trim().length === 0) return decision === "request_changes" ? "note_required" : null;
    if (note.length > MAX_PLAN_NOTE_LENGTH) return "note_too_long";
    if (hasUnsafeDirectiveControlChars(note)) return "note_invalid";
    return null;
  }

  async function decidePlan(itemId: number, input: DecidePlanInput, opts: DecidePlanOptions = {}): Promise<DecidePlanOutcome> {
    const refusal = noteRefusal(input.decision, input.note);
    if (refusal !== null) return { result: { ok: false, reason: refusal } };
    const note = input.note !== undefined && input.note.trim().length > 0 ? input.note.trim() : undefined;
    if (inFlight.has(itemId)) {
      // planPhase stores the pending plan, then finishes its transcript before the run releases the item. A decision in that window is
      // early, not concurrent with a run, so it is told to retry rather than that the item is running.
      return { result: { ok: false, reason: planSettling.has(itemId) ? "plan_settling" : "already_running" } };
    }
    // Claimed synchronously before the store write, so a second decision or a run start for this item waits on this one.
    inFlight.add(itemId);
    const status = DECISION_STATUS[input.decision];
    let decided: Awaited<ReturnType<WorkBoardStore["decidePlan"]>>;
    try {
      decided = await store.decidePlan(itemId, {
        runId: input.runId,
        planHash: input.planHash,
        status,
        ...(note !== undefined ? { note } : {}),
      });
    } catch (err) {
      // The decision was not stored, so nothing runs.
      inFlight.delete(itemId);
      throw err;
    }
    if (decided.status === "refused") {
      inFlight.delete(itemId);
      return { result: { ok: false, reason: decided.reason } };
    }
    const { item, planApproval } = decided;
    log.info(
      "[work-approval:decided] %s run=%s plan=%s decision=%s",
      workBoardOriginSessionId(itemId),
      planApproval.runId,
      planApproval.planHash.slice(0, 8),
      planApproval.status,
    );
    const recorder = openRecorder(itemId, planApproval.runId);
    // The transcript row carries the decision, never the note body.
    recorder.record({ phase: "awaiting_approval", kind: "decision", message: planApproval.status });

    if (status === "rejected") {
      inFlight.delete(itemId);
      emit({ itemId, phase: "denied", message: "rejected" });
      await recorder.flush();
      return { result: { ok: true, status } };
    }

    const plan = item.plan;
    if (typeof plan !== "string") {
      inFlight.delete(itemId);
      throw new Error(`work item #${itemId} has a decided plan approval but no plan`);
    }
    const continuation = guarded(itemId, opts.approvalSurface, async () => {
      try {
        const runner = getRunner();
        if (!runner) throw new Error("sub-agent runner not available");
        const resolved = await resolveProfile(planApproval.agentName);
        if (!resolved.ok) throw new Error(resolved.reason);
        if (status === "approved") {
          return await executePhase(itemId, item, plan, resolved.profile, runner, recorder);
        }
        const planTools = planReadOnlyToolNames(runner.parentToolRegistry());
        if (planTools.length === 0) throw new Error(PLAN_TOOLS_EMPTY);
        if (note === undefined) throw new Error("a change request reached re-planning without its note");
        return await planPhase({
          itemId,
          item,
          runId: planApproval.runId,
          runner,
          planTools,
          profile: resolved.profile,
          ...(planApproval.agentName ? { agentName: planApproval.agentName } : {}),
          revision: planApproval.revision + 1,
          revisionRequest: { priorPlan: plan, note },
          recorder,
        });
      } catch (err) {
        return failRun(itemId, err, recorder);
      }
    });
    return { result: { ok: true, status }, continuation };
  }

  async function runBriefing(
    kind: WorkBoardBriefingKind,
    opts: BriefingOptions = {},
  ): Promise<WorkBoardBriefingResult> {
    if (briefingInFlight.has(kind)) {
      return { status: "error", kind, reason: `the ${kind} briefing is already running` };
    }
    briefingInFlight.add(kind);
    const originSessionId = `work-board-briefing:${kind}`;
    updateApprovalSurface({ kind: "attach", sessionId: originSessionId, surface: opts.approvalSurface ?? null });
    try {
      const runner = getRunner();
      if (!runner) {
        return { status: "error", kind, reason: "sub-agent runner not available" };
      }
      const surveyTools = planReadOnlyToolNames(runner.parentToolRegistry());
      if (surveyTools.length === 0) {
        return { status: "error", kind, reason: PLAN_TOOLS_EMPTY };
      }

      const listed = await store.list(
        opts.projectRoot
          ? { projectRoot: opts.projectRoot, includeUnscoped: opts.includeUnscoped === true }
          : undefined,
      );
      const openItems =
        listed.status === "ok"
          ? listed.items.filter((item) => item.status_resolved !== "completed")
          : [];

      const survey = await runner.spawn({
        title: `Briefing: ${kind}`,
        instructions: buildBriefingPrompt(kind, openItems),
        toolScope: exactToolScope(surveyTools),
        originSessionId,
        ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
        profileMode: "plan",
        maxRounds: BRIEFING_ROUND_BUDGET,
      });
      if (survey.ok === false) {
        const reason = survey.error ?? survey.summary;
        log.warn("runBriefing survey failed (kind=%s): %s", kind, reason);
        return { status: "error", kind, reason };
      }

      const parsed = parseBriefingActionItems(kind, survey.summary);
      if (!parsed.ok) {
        log.warn("runBriefing parse failed (kind=%s): %s", kind, parsed.reason);
        return { status: "error", kind, reason: parsed.reason };
      }
      if (parsed.items.length === 0) {
        return { status: "empty", kind, reason: "the survey found nothing that needs attention" };
      }

      const { filed, refreshed } = await store.fileBriefingProposals(parsed.items);
      return { status: "ok", kind, filed, refreshed };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn("runBriefing error (kind=%s): %s", kind, reason);
      return { status: "error", kind, reason };
    } finally {
      briefingInFlight.delete(kind);
      updateApprovalSurface({ kind: "release", sessionId: originSessionId });
    }
  }

  /** A recorded execute child implies a constructed runner; a missing one is a wiring fault, not a refusal. */
  function runnerForLiveChild(): SubAgentRunner {
    const runner = getRunner();
    if (!runner) throw new Error("work-board execute child is recorded but the sub-agent runner is not available");
    return runner;
  }

  function steerRun(itemId: number, text: string): WorkBoardSteerResult {
    const child = executingChildByItem.get(itemId);
    if (child === undefined) return { ok: false, reason: "not-executing" };
    const turnOf = executingTurnByItem.get(itemId);
    // The outcome is reported only when the child's loop says so: queued is not delivered (LS-2 G4). The id is filled in before the
    // loop can report, since it reports at a later round boundary, never inside this call.
    let messageId: string | undefined;
    const report = (steer: WorkBoardSteerAck): void => emit({ itemId, phase: "executing", steer });
    const queued = runnerForLiveChild().queueHostDirectiveToWorkBoardChild(workBoardOriginSessionId(itemId), child, text, {
      onInjected: () => {
        if (messageId === undefined) throw new Error("work-board steer was injected before it was queued");
        // The loop acknowledges an injection after the round that took it reported (conversation-loop-guidance pins that order), and the
        // runner reports each round's activity synchronously, so the last recorded turn is the one that received the steer.
        report({ messageId, status: "delivered", turn: turnOf?.() ?? 0 });
      },
      onDropped: (reason) => {
        if (messageId === undefined) throw new Error("work-board steer was dropped before it was queued");
        report({ messageId, status: "dropped", reason });
      },
    });
    if (!queued.ok) return { ok: false, reason: queued.reason };
    messageId = queued.messageId;
    return { ok: true, messageId };
  }

  function cancelRun(itemId: number): WorkBoardCancelResult {
    const child = executingChildByItem.get(itemId);
    if (child === undefined) return { ok: false, reason: "not-executing" };
    // A second stop while the first is unwinding is the same stop. The runner already marked the run interrupted and would refuse a
    // second interrupt; clearing the first call's mark on that refusal would turn the user's stop into an error.
    if (cancelRequested.has(itemId)) return { ok: true };
    // Mark before interrupting: the runner may unwind and report synchronously inside interruptRun.
    cancelRequested.add(itemId);
    // "Ordinary parent/child cancellation … remain effective" (permission-decision-tree.md, Delegated work): the existing interrupt path,
    // whose turn abort also settles any parked approval card of the child through the gate's own abort handling.
    const interrupted = runnerForLiveChild().interruptRun(child, workBoardOriginSessionId(itemId));
    if (!interrupted.ok) {
      cancelRequested.delete(itemId);
      return { ok: false, reason: "not-running" };
    }
    return { ok: true };
  }

  return {
    runItem,
    decidePlan,
    runBriefing,
    executingChildSessionId: (itemId) => executingChildByItem.get(itemId),
    steerRun,
    cancelRun,
  };
}
