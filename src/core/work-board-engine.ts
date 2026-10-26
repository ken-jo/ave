/** Sequence isolated plan and execution children around per-run approval; persist their output and execution session id on the board. */
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { updateApprovalSurface } from "../permissions/approval-surface-registry.js";
import {
  exactToolScope,
  PARENT_ALL_TOOL_SCOPE,
  type SubAgentRunner,
} from "../engine/subagent-runner.js";
import type {
  ApprovalGate,
  ApprovalDecision,
} from "../permissions/approval-gate.js";
import type { LoadedAgentProfile } from "../main/agent-profile-store.js";
import type { WorkBoardStore } from "../main/work-board-store.js";
import type {
  WorkItem,
  WorkItemResolved,
  WorkBoardBriefingKind,
  WorkBoardBriefingResult,
  WorkBoardRunEvent,
  WorkProposalInput,
} from "../shared/work-board-types.js";
import {
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
import { errorMessage } from "../shared/error-message.js";
import { requiredTier } from "../permissions/permission-manager.js";
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

/** Record each completed round once per phase; repeated tool and streaming callbacks must not append blank or duplicate rows. */
function makeTurnRecorder(
  onTurn: (turn: number, text: string) => void,
): (u: SubAgentActivityUpdate) => void {
  let lastTurn = 0;
  return (u) => {
    const { turn, text } = activityToTurn(u);
    if (turn <= lastTurn) return;
    lastTurn = turn;
    onTurn(turn, text);
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
  approvalGate: ApprovalGate;
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
  status: "completed" | "denied" | "not_found" | "error" | "already_running";
  output?: string;
  plan?: string;
  runSessionId?: string;
  /** Busy means another run owns the item and no second child was spawned. */
  reason?: string;
}

export interface WorkBoardEngine {
  /** Combine in-process and persisted active-status guards per item; finished reruns start clean while preserving history. */
  runItem(itemId: number, opts?: RunItemOptions): Promise<RunItemResult>;

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

/** Only explicit allow decisions execute; rejection and approval timeout deny. */
function isDenied(decision: ApprovalDecision): boolean {
  return decision.choice.startsWith("deny");
}

/** Clamp durable plan approvals to this run and drop rememberPattern; one click must never authorize future plans. */
function clampToOnceForRun(decision: ApprovalDecision): ApprovalDecision {
  if (decision.choice === "allow-always" || decision.choice === "allow-session") {
    return { ...decision, choice: "allow-once", rememberPattern: undefined };
  }
  return decision;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  "planning",
  "awaiting_approval",
  "executing",
]);

export function createWorkBoardEngine(
  deps: WorkBoardEngineDeps,
): WorkBoardEngine {
  const { store, getRunner, approvalGate, getAgentProfile, emitProgress, onRunComplete, transcriptStorage } =
    deps;

  /** Set the in-process guard before awaiting persisted status to close the duplicate-run race. */
  const inFlight = new Set<number>();

  /** Allow one survey per window so duplicate clicks cannot incur duplicate child runs. */
  const briefingInFlight = new Set<WorkBoardBriefingKind>();

  const emit = (event: Omit<WorkBoardRunEvent, "at">): void => {
    emitProgress({ ...event, at: new Date().toISOString() });
  };

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
    const originSessionId = workBoardOriginSessionId(itemId);
    updateApprovalSurface({ kind: "attach", sessionId: originSessionId, surface: opts.approvalSurface ?? null });
    try {
      return await runItemGuarded(itemId, item, opts);
    } finally {
      inFlight.delete(itemId);
      updateApprovalSurface({ kind: "release", sessionId: originSessionId });
    }
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
    let profile: LoadedAgentProfile | null = null;
    if (opts.agentName) {
      profile = (await getAgentProfile?.(opts.agentName)) ?? null;
      if (!profile) {
        await store.setRunResult(itemId, { runStatus: "error" });
        emit({
          itemId,
          phase: "error",
          message: `agent profile not found: ${opts.agentName}`,
        });
        return {
          status: "error",
          reason: `agent profile not found: ${opts.agentName}`,
        };
      }
    }

    const originSessionId = workBoardOriginSessionId(itemId);
    const runId = randomUUID();
    const startedAt = new Date(Date.now()).toISOString();

    // Serialize and drain transcript appends before terminal returns, including catch; write failures must not fail the run.
    const transcript: RunTranscriptWriter | null = transcriptStorage
      ? createRunTranscript(transcriptStorage, itemId, runId)
      : null;
    let transcriptChain: Promise<void> = Promise.resolve();
    const record = (e: Parameters<RunTranscriptWriter["append"]>[0]): void => {
      if (!transcript) return;
      transcriptChain = transcriptChain
        .then(() => transcript.append(e))
        .catch((err) =>
          log.warn("runItem transcript append failed (id=%d): %s", itemId, (err as Error).message),
        );
    };
    const flushTranscript = (): Promise<void> => transcriptChain;

    try {
      // Archive prior runs before resetting latest fields so denied reruns cannot display stale success.
      await store.beginRun(itemId, runId, startedAt);

      emit({ itemId, phase: "planning" });

      const planResult = await runner.spawn(
        {
          title: `Plan: ${item.title}`,
          instructions: buildPlanPrompt(item),
          toolScope: exactToolScope(planTools),
          originSessionId,
          ...(item.projectRoot ? { projectRoot: item.projectRoot } : {}),
          profileMode: "plan",
          profileModel: profile?.model,
          maxRounds: PLAN_ROUND_BUDGET,
        },
        {
          onActivity: makeTurnRecorder((turn, text) => {
            emit({ itemId, phase: "planning", turn, text });
            record({ phase: "planning", kind: "turn", turn, text });
          }),
          onError: (message) => emit({ itemId, phase: "error", message }),
        },
      );
      const plan = planResult.summary;
      record({ phase: "awaiting_approval", kind: "plan", text: plan });
      await store.setRunResult(itemId, {
        runStatus: "awaiting_approval",
        plan,
        runSessionId: planResult.childSessionId,
      });

      // Use a fresh agent-action approval id and clamp to once so every plan requires explicit new consent.
      emit({ itemId, phase: "awaiting_approval" });
      const rawDecision = await approvalGate.requestAndWait({
        id: `work-board-run:${itemId}:${randomUUID()}`,
        sessionId: originSessionId,
        category: "agent-action",
        kind: "agent-action",
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        toolName: "work_board_run",
        toolCategory: "meta",
        reason: `Work item #${itemId} "${item.title}" — approve plan to execute?`,
        args: { plan },
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin: "user-keyboard",
      });
      const decision = clampToOnceForRun(rawDecision);

      if (isDenied(decision)) {
        await store.setRunResult(itemId, { runStatus: "denied", plan });
        record({ phase: "denied", kind: "decision", message: decision.choice });
        const reason = decision.rememberPattern ?? decision.choice;
        emit({ itemId, phase: "denied", message: reason });
        await flushTranscript();
        return { status: "denied", plan, reason };
      }

      // Full execution scope still passes every tool through its own approval gate.
      await store.setRunStatus(itemId, "executing");
      emit({ itemId, phase: "executing" });

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
          onActivity: makeTurnRecorder((turn, text) => {
            emit({ itemId, phase: "executing", turn, text });
            record({ phase: "executing", kind: "turn", turn, text });
          }),
          onError: (message) => emit({ itemId, phase: "error", message }),
        },
      );
      // Treat ok:false as error, never as completed output containing the error summary.
      if (execResult.ok === false) {
        const reason = execResult.error ?? execResult.summary;
        log.warn("runItem execute failed (id=%d): %s", itemId, reason);
        await store.setRunResult(itemId, { runStatus: "error" });
        record({ phase: "error", kind: "error", message: reason });
        emit({ itemId, phase: "error", message: reason });
        await flushTranscript();
        return { status: "error", reason };
      }

      const output = execResult.summary;

      await store.setRunResult(itemId, {
        runStatus: "completed",
        plan,
        output,
        runSessionId: execResult.childSessionId,
      });
      record({ phase: "done", kind: "output", text: output });
      emit({
        itemId,
        phase: "done",
        runSessionId: execResult.childSessionId,
      });
      await flushTranscript();
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
            log.warn("runItem onRunComplete failed (id=%d): %s", itemId, (e as Error).message),
          );
      }
      return {
        status: "completed",
        plan,
        output,
        runSessionId: execResult.childSessionId,
      };
    } catch (err) {
      const reason = errorMessage(err);
      log.warn("runItem error (id=%d): %s", itemId, reason);
      await store
        .setRunResult(itemId, { runStatus: "error" })
        .catch((persistErr) =>
          log.warn(
            "runItem error-state persist failed (id=%d): %s",
            itemId,
            (persistErr as Error).message,
          ),
        );
      record({ phase: "error", kind: "error", message: reason });
      emit({ itemId, phase: "error", message: reason });
      await flushTranscript();
      return { status: "error", reason };
    }
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

  return { runItem, runBriefing };
}
