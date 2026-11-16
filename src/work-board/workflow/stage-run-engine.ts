/** Runs a template run's stages: one serial event queue per item, the pure reducer for every state change, and the only spawn site of a
 * stage child. Each child's tool calls still enter the ordinary permission tree; nothing here decides a permission. */
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { WebContents } from "electron";
import { hasUnsafeDirectiveControlChars } from "../../engine/parent-directive.js";
import { exactToolScope, PARENT_ALL_TOOL_SCOPE, type SubAgentRunner, type SubAgentSpawnResult } from "../../engine/subagent-runner.js";
import { createLogger } from "../../lib/logger.js";
import type { LoadedAgentProfile } from "../../main/agent-profile-store.js";
import type { WorkBoardStore } from "../../main/work-board-store.js";
import type { WorkflowTemplateStore } from "../../main/workflow-template-store.js";
import { requiredTier } from "../../permissions/permission-manager.js";
import { updateApprovalSurface } from "../../permissions/approval-surface-registry.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  MAX_PLAN_NOTE_LENGTH, workBoardOriginSessionId,
  type StageGateDecideInput, type StageGateDecideResult, type StageJoinDecideInput, type StageJoinDecideResult, type StageRetryResult,
  type WorkBoardCancelResult, type WorkBoardRunEvent, type WorkBoardSteerAck, type WorkBoardSteerResult, type WorkItem, type WorkItemResolved,
  type WorkItemRunResult,
} from "../../shared/work-board-types.js";
import { outputHashOf, resultHashOf } from "../../shared/workflow-template-output.js";
import type {
  EnvelopeToolRef, RequestedOutput, RunAuthoritySource, StageEnvelope, TemplateScope, TemplateStage, TemplateVersion, UnattendedQualification,
  WorkItemStageRun,
} from "../../shared/workflow-template-types.js";
import { isAllReadOnlyVersion, WorkflowTemplateError } from "../template-graph.js";
import type { AuthoriseRunSource, RunAuthorityVerdict } from "./run-authority.js";
import type { LaneBlockCode, OutputExecution, RunPin, StageFailure } from "./shipped-shapes.js";
import type { PassConditionRegistry } from "./stage-gates.js";
import { assertPinnedVersion, stepsOf } from "./stage-graph.js";
import { MAX_STAGE_ATTEMPTS, reduceRun, type RunEffect, type RunEvent } from "./stage-machine.js";
import { buildStagePrompt, type StageInput } from "./stage-prompt.js";
import { isAwaitingStageReview, reconcileRunRecord, type RunRecord, type WorkflowRunState } from "./run-state.js";
import type { RunRef, StageWorkspaceProvider } from "./stage-workspace.js";
import { WorkflowInvariantError } from "./workflow-errors.js";

const log = createLogger("work-board-stage-run");

/** The host bounds a read-scope stage's rounds, as it does for the plan child of an ordinary run. */
const READ_STAGE_ROUND_BUDGET = 20;
const STAGE_OUTPUT_MAX_CHARS = 48_000;

const runKeyOf = (itemId: number, runId: string): string => `work-board:${itemId}#${runId}`;

interface RunScopeHooks { sessionLinked(runKey: string, sessionId: string): void; sessionEnded(sessionId: string): void; runEnded(runKey: string): void }
interface LaneHooks {
  admit(a: { runKey: string; stageId: string; envelope: StageEnvelope | undefined; workspaceRoot: string }): Promise<{ ok: true } | { ok: false; code: LaneBlockCode }>;
  sessionLinked(a: { runKey: string; stageId: string; sessionId: string; envelope: StageEnvelope; workspaceRoot: string }): void;
  sessionEnded(sessionId: string): void;
  onDenied(listener: (e: { sessionId: string; code: string }) => void): () => void;
}
interface RequestedOutputHooks {
  accept(a: { stage: TemplateStage; workspaceRoot: string; raw: unknown }): { ok: true; output: RequestedOutput } | { ok: false; code: string };
  execute(a: { run: RunRef; stageId: string; output: RequestedOutput; approvalSurface: WebContents | null }): Promise<OutputExecution>;
}

export interface StageRunEngineDeps {
  /** The board: the row of a run carries its id, its shown status and its final output. Nothing a run is decided from is read here. */
  store: Pick<WorkBoardStore, "get" | "setRunStatus" | "setRunResult" | "boardChanged">;
  /** Every run-authority field: the pin, the source, the stage runs, the joins, the gates and how the run ended. */
  runs: WorkflowRunState;
  /** The authorised registry root of a project path, or null when the registry does not hold it. */
  resolveProjectRoot: (projectRoot: string) => string | null;
  templates: Pick<WorkflowTemplateStore, "get" | "resolveVersion">;
  attachments: Pick<WorkflowTemplateStore, "getAttachment" | "listByTemplate" | "listByRoutine">;
  getRunner: () => SubAgentRunner | undefined;
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  emit: (e: Omit<WorkBoardRunEvent, "at">) => void;
  /** What a board reader is told about the item's run changed without a board write (a gate opened, a restart's run was taken over). */
  itemChanged?: (itemId: number) => void;
  /** Default: no template run can start until a real provider is wired. */
  workspace: StageWorkspaceProvider;
  authoriseRunSource: AuthoriseRunSource;
  /** The project-access check the template handlers use, applied to the scope an approval bound. */
  scopeAuthorised: (scope: TemplateScope) => boolean;
  /** May this version run unattended. Absent: only an all-read-only version may. */
  unattendedAllowed?: (version: TemplateVersion) => UnattendedQualification;
  /** Absent: an unattended stage is refused `lane-unavailable` unless the version is all read-only. */
  lane?: LaneHooks;
  /** Absent: a stage that declares requested outputs is refused `outputs-unavailable`. */
  outputs?: RequestedOutputHooks;
  /** Absent: no-op. */
  runScope?: RunScopeHooks;
  passConditions: PassConditionRegistry;
  /** The core engine's in-flight guard: a template run holds its item from start to settle. */
  holdItem: (itemId: number) => void;
  releaseItem: (itemId: number) => void;
  /** Record a run that the run authority ended. */
  audit?: (e: { itemId: number; runId: string; event: "work-run:authority-refused"; code: string; tool?: EnvelopeToolRef }) => void;
}

export interface StageRunEngine {
  start(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<WorkItemRunResult>;
  decideGate(itemId: number, i: StageGateDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageGateDecideResult>;
  decideJoin(itemId: number, i: StageJoinDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageJoinDecideResult>;
  retryStage(itemId: number, i: { runId: string; stageId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult>;
  /** Start whatever is ready in a run that has no live child (after a restart). Not a retry: no attempt is used. */
  continueRun(itemId: number, i: { runId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult>;
  /** Interrupt every live stage child of runs on that project and fail those stages `workspace-revoked`. */
  projectRootRevoked(canonicalRoot: string): void;
  steer(itemId: number, stageId: string, text: string): WorkBoardSteerResult;
  stop(itemId: number): WorkBoardCancelResult;
  liveStageSessions(itemId: number): ReadonlyMap<string, string>;
  /** Boot, once: show each row whose run is over as the run file says, take over the runs a restart left unsettled (so Stop reaches
   * them) and sweep the workspaces no run owns. Spawns nothing. */
  adoptParkedRuns(): Promise<void>;
  /** Adds what a board reader is told about each row's template run. */
  projectRuns<T extends WorkItemResolved>(items: readonly T[]): Promise<T[]>;
  /** Resolves when the run has no queued event and no live or starting child. */
  whenIdle(itemId: number): Promise<void>;
}

interface RunState {
  itemId: number;
  runId: string;
  ref: RunRef;
  projectRoot: string | undefined;
  surface: WebContents | null;
  chain: Promise<unknown>;
  /** Launches between the reducer's spawn effect and the child's end event. */
  busy: number;
  waiters: Set<() => void>;
  stopping: boolean;
  /** No board row names the run any more. */
  rowGone: boolean;
  /** Why the run ends `error` without its graph being asked. */
  faulted: string | null;
  refused: { code: string; tool?: EnvelopeToolRef } | null;
  /** stageId → childSessionId, set when the child links. */
  live: Map<string, string>;
  /** `${stageId}#${attempt}` the reducer asked to spawn and no launch consumed yet. */
  due: Set<string>;
  starting: Set<string>;
  interruptAsked: Set<string>;
  revoked: Set<string>;
  results: Map<string, SubAgentSpawnResult>;
}

type Precheck<R extends string> = (record: RunRecord) => R | null;
type Settled = NonNullable<RunRecord["settled"]>["status"];
type PinRefusal = "version_missing" | "graph_mismatch";

function rootKey(root: string): string {
  const normal = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normal.toLowerCase() : normal;
}

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function pinFault(error: unknown): "version-missing" | "graph-mismatch" | null {
  if (error instanceof WorkflowInvariantError && (error.code === "version-missing" || error.code === "graph-mismatch")) return error.code;
  if (!(error instanceof WorkflowTemplateError)) return null;
  if (error.code === "template-not-found" || error.code === "unknown-version") return "version-missing";
  return error.code === "graph-hash-mismatch" ? "graph-mismatch" : null;
}

export function createStageRunEngine(deps: StageRunEngineDeps): StageRunEngine {
  const { store, templates, workspace, emit } = deps;
  const records = deps.runs;
  const runs = new Map<number, RunState>();
  let adoption: Promise<void> | null = null;
  const unattendedAllowed = deps.unattendedAllowed
    ?? ((version: TemplateVersion): UnattendedQualification => isAllReadOnlyVersion(version) ? { ok: true } : { ok: false, code: "unattended-not-read-only" });

  function wake(state: RunState): void {
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  function openState(itemId: number, runId: string, projectRoot: string | undefined, surface: WebContents | null): RunState {
    const state: RunState = {
      itemId, runId, ref: { itemId, runId, runKey: runKeyOf(itemId, runId) }, projectRoot, surface, chain: Promise.resolve(), busy: 0, waiters: new Set(),
      stopping: false, rowGone: false, faulted: null, refused: null, live: new Map(), due: new Set(), starting: new Set(), interruptAsked: new Set(),
      revoked: new Set(), results: new Map(),
    };
    runs.set(itemId, state);
    deps.holdItem(itemId);
    updateApprovalSurface({ kind: "attach", sessionId: workBoardOriginSessionId(itemId), surface });
    return state;
  }

  function closeState(state: RunState): void {
    if (runs.get(state.itemId) !== state) return;
    runs.delete(state.itemId);
    deps.releaseItem(state.itemId);
    updateApprovalSurface({ kind: "release", sessionId: workBoardOriginSessionId(state.itemId) });
    deps.runScope?.runEnded(state.ref.runKey);
    wake(state);
  }

  /** The project a run works on, from what authorised it: the card's root for Create and run, the approved snapshot for a schedule. */
  async function runProjectOf(source: RunAuthoritySource): Promise<string | undefined> {
    if (source.kind === "local-create-and-run") return source.projectRoot;
    const approved = (await deps.attachments.getAttachment(source.attachmentId))?.approvedScope;
    return approved?.kind === "project" ? approved.projectRoot : undefined;
  }

  /** The state of an unsettled run, created on demand for a run a restart left parked. */
  async function stateFor(record: RunRecord, surface: WebContents | null): Promise<RunState | null> {
    if (record.settled !== undefined) return null;
    const known = runs.get(record.itemId);
    if (known !== undefined) {
      if (known.runId !== record.runId) return null;
      if (surface !== null && surface !== known.surface) {
        known.surface = surface;
        updateApprovalSurface({ kind: "attach", sessionId: workBoardOriginSessionId(record.itemId), surface });
      }
      return known;
    }
    const projectRoot = await runProjectOf(record.runStartedBy);
    return runs.get(record.itemId) ?? openState(record.itemId, record.runId, projectRoot, surface);
  }

  async function resolvePinned(pin: RunPin): Promise<TemplateVersion> {
    const version = await templates.resolveVersion(pin);
    assertPinnedVersion(version, pin);
    return version;
  }

  async function verdictFor(phase: "start" | "spawn", projectRoot: string | undefined, source: RunAuthoritySource, pin: RunPin): Promise<RunAuthorityVerdict> {
    let template = null;
    let stored = null;
    let storedHashMatches = true;
    try {
      template = (await templates.get(pin.templateId)).template;
    } catch (error) {
      if (!(error instanceof WorkflowTemplateError) || error.code !== "template-not-found") throw error;
    }
    try {
      stored = await templates.resolveVersion(pin);
    } catch (error) {
      const fault = pinFault(error);
      if (fault === null) throw error;
      storedHashMatches = fault !== "graph-mismatch";
    }
    const attachment = source.kind === "schedule-attachment" ? await deps.attachments.getAttachment(source.attachmentId) : null;
    return deps.authoriseRunSource({
      phase, source, runPin: pin, template, stored, storedHashMatches, attachment, runProjectRoot: projectRoot,
      scopeAuthorised: deps.scopeAuthorised, unattendedAllowed,
    });
  }

  function enqueue<T>(state: RunState, task: () => Promise<T>): Promise<T> {
    const next = state.chain.then(task);
    state.chain = next.catch((error: unknown) => {
      log.warn("stage run event failed (id=%d): %s", state.itemId, errorMessage(error));
    });
    return next;
  }

  function post(state: RunState, event: RunEvent): void {
    void enqueue(state, () => handle(state, event)).catch(() => undefined);
  }

  /** The run's board row is gone: the run is cancelled as by Stop, and from here its record is written by run id alone. */
  function rowRemoved(state: RunState): void {
    if (state.rowGone || runs.get(state.itemId) !== state) return;
    state.rowGone = true;
    state.stopping = true;
    post(state, { type: "stop_requested" });
  }

  /** After any board write: a run whose row was deleted, by whichever path, is cancelled. */
  async function checkRows(): Promise<void> {
    for (const state of [...runs.values()]) {
      if (state.rowGone) continue;
      const got = await store.get(state.itemId);
      if (got.status !== "found" || got.item.runId !== state.runId) rowRemoved(state);
    }
  }
  store.boardChanged.subscribe(() => {
    if (runs.size > 0) void checkRows().catch((error: unknown) => log.warn("stage run row check failed: %s", errorMessage(error)));
  });

  /** One write of the run. Null when nothing was stored. */
  async function writeRun(state: RunState, mutate: (run: RunRecord) => RunRecord | null): Promise<{ run: RunRecord } | { run: null; reason: "row-gone" | "refused" | "unavailable" }> {
    const result = await records.update(state.itemId, state.runId, mutate, state.rowGone);
    if (result.ok) return { run: result.run };
    if (result.reason === "row-gone") rowRemoved(state);
    return { run: null, reason: result.reason };
  }

  function interruptAll(state: RunState): void {
    for (const stageId of state.starting) state.interruptAsked.add(stageId);
    for (const [stageId, child] of state.live) {
      if (state.interruptAsked.has(stageId)) continue;
      state.interruptAsked.add(stageId);
      deps.getRunner()?.interruptRun(child, workBoardOriginSessionId(state.itemId));
    }
  }

  function finalOutput(record: RunRecord, version: TemplateVersion | null): string | undefined {
    const lastStage = version ? stepsOf(version).at(-1)?.at(-1) : undefined;
    return record.stageRuns.find(run => run.stageId === lastStage)?.output;
  }

  /** The board row shows what the run file already says. A row that is gone, or a write that fails, leaves the record as the truth: boot
   * shows the row from it again. */
  async function showOnRow(itemId: number, runStatus: Settled, output: string | undefined): Promise<void> {
    await store.setRunResult(itemId, { runStatus, ...(runStatus === "completed" && output !== undefined ? { output } : {}) })
      .catch((error: unknown) => log.warn("stage run result not shown on the board (id=%d): %s", itemId, errorMessage(error)));
  }

  /** After the run file says the run is over: show it on the row, tell the listeners, and let the item go. */
  async function finish(state: RunState, record: RunRecord | null, runStatus: Settled, version: TemplateVersion | null, message?: string): Promise<void> {
    await showOnRow(state.itemId, runStatus, record ? finalOutput(record, version) : undefined);
    const byAuthority = state.refused !== null && runStatus === "cancelled" && !state.stopping;
    const reason = byAuthority && state.refused
      ? { reasonCode: state.refused.code, ...(state.refused.tool ? { reasonTool: state.refused.tool } : {}) }
      : {};
    if (byAuthority && state.refused) {
      deps.audit?.({ itemId: state.itemId, runId: state.runId, event: "work-run:authority-refused", code: state.refused.code, ...(state.refused.tool ? { tool: state.refused.tool } : {}) });
    }
    const phase = runStatus === "completed" ? "done" : runStatus;
    const told = message ?? (runStatus !== "cancelled" || !state.stopping ? undefined : state.rowGone ? "item-removed" : "user-stopped");
    emit({ itemId: state.itemId, phase, ...(told ? { message: told } : {}), ...reason });
    closeState(state);
    deps.itemChanged?.(state.itemId);
  }

  /** Ends a run without its graph: the pin no longer resolves, or the run file cannot be written. Every live child is interrupted from the
   * host's own record of them, and the run is over only when the last one has unwound. A stop stays `cancelled`; anything else is `error`. */
  async function unwind(state: RunState, event: RunEvent, cause: string): Promise<void> {
    if (!state.stopping) state.faulted ??= cause;
    interruptAll(state);
    const idle = state.busy === 0 && state.live.size === 0;
    const runStatus: Settled = state.stopping ? "cancelled" : "error";
    const now = new Date().toISOString();
    const written = await writeRun(state, (current) => {
      if (current.settled !== undefined) return null;
      const stageRuns = current.stageRuns.map((run): WorkItemStageRun => {
        if (event.type === "stage_ended" && run.stageId === event.stageId && run.attempt === event.attempt && run.status === "running") {
          return { ...run, status: "cancelled", endedAt: now, ...(event.output !== undefined ? { output: event.output } : {}), ...(event.taint ? { taint: event.taint } : {}) };
        }
        return idle && (run.status === "waiting" || run.status === "running" || run.status === "awaiting_gate") ? { ...run, status: "cancelled" } : run;
      });
      return { ...current, stageRuns, ...(idle ? { settled: { status: runStatus, at: now } } : {}) };
    }).catch((error: unknown) => { log.warn("stage run could not be ended in the run file (id=%d): %s", state.itemId, errorMessage(error)); return { run: null }; });
    if (!idle) return;
    await workspace.release(state.ref, "all").catch(() => undefined);
    await finish(state, written.run, runStatus, null, state.stopping ? undefined : state.faulted ?? cause);
  }

  /** One event: resolve the pin, then one atomic write that checks, reduces and stores the run as it is at that moment, then the effects.
   * `precheck` refuses a user decision before anything is written; the pin is checked before it runs. */
  async function handle<R extends string = never>(state: RunState, event: RunEvent, precheck?: Precheck<R>): Promise<R | PinRefusal | "run_mismatch" | "not_found" | null> {
    if (runs.get(state.itemId) !== state) {
      log.warn("dropped a stage event of another run (id=%d, event=%s)", state.itemId, event.type);
      return "run_mismatch";
    }
    const read = await records.get(state.itemId, state.runId);
    if (!read) {
      if (precheck) return "not_found";
      await unwind(state, event, "run-state-unavailable");
      return "not_found";
    }
    if (read.settled !== undefined) return "run_mismatch";
    let version: TemplateVersion;
    try {
      version = await resolvePinned(read.pin);
      stepsOf(version);
    } catch (error) {
      const fault = pinFault(error);
      // A user decision against an unreadable pin is refused and changes nothing; a scheduler event ends the run.
      if (precheck && fault !== null) return fault === "version-missing" ? "version_missing" : "graph_mismatch";
      await unwind(state, event, fault ?? errorMessage(error));
      return null;
    }

    const now = new Date().toISOString();
    let refusal: R | "run_mismatch" | null = null;
    let before: readonly WorkItemStageRun[] = [];
    let effects: RunEffect[] = [];
    const written = await writeRun(state, (current) => {
      // Reduced from the run as stored now, inside the write: a field another write stored meanwhile is never lost.
      refusal = current.settled !== undefined ? "run_mismatch" : precheck?.(current) ?? null;
      if (refusal !== null) return null;
      before = current.stageRuns;
      const step = reduceRun({
        graph: version, stageRuns: current.stageRuns, joins: current.stageJoins ?? [], stopping: state.stopping, refused: state.refused !== null,
        faulted: state.faulted !== null, now,
      }, event);
      effects = step.effects;
      // The write that ends the run says so: the final stage states and how it ended are one write.
      return { ...current, stageRuns: step.stageRuns, stageJoins: step.joins, ...(step.runStatus !== "executing" ? { settled: { status: step.runStatus, at: now } } : {}) };
    });
    if (written.run === null) {
      if (refusal !== null) return refusal;
      if (written.reason === "row-gone") return "run_mismatch";
      log.warn("stage run write failed (id=%d, event=%s)", state.itemId, event.type);
      if (precheck) return "run_mismatch";
      await unwind(state, event, "run-state-unavailable");
      return null;
    }
    const record = written.run;
    let shown = false;
    for (const run of record.stageRuns) {
      const prior = before.find(candidate => candidate.stageId === run.stageId);
      if (prior?.status === run.status && prior.attempt === run.attempt) continue;
      shown = true;
      const about = { itemId: state.itemId, stageId: run.stageId, attempt: run.attempt };
      if (run.status === "awaiting_gate") emit({ ...about, phase: "stage_gate" });
      else if (run.status === "passed") emit({ ...about, phase: "stage_passed" });
      else if (run.status === "failed") emit({ ...about, phase: "stage_failed", ...(run.failure ? { message: run.failure } : {}) });
    }
    if (shown || (record.stageJoins ?? []).some(join => join.status === "conflict")) deps.itemChanged?.(state.itemId);
    await runEffects(state, record, version, effects);
    return null;
  }

  function fault(state: RunState, cause: string): void {
    state.faulted ??= cause;
    post(state, { type: "fault" });
  }

  async function runEffects(state: RunState, record: RunRecord, version: TemplateVersion, effects: RunEffect[]): Promise<void> {
    let sealFailed = false;
    for (const effect of effects) {
      switch (effect.type) {
        case "spawn":
          state.due.add(`${effect.stageId}#${effect.attempt}`);
          state.busy += 1;
          void launch(state, effect.stageId, effect.attempt);
          break;
        case "evaluate_gate": {
          const stage = version.stages.find(candidate => candidate.id === effect.stageId);
          const result = state.results.get(effect.stageId);
          const verdict = stage?.gate.type === "auto" && result
            ? await deps.passConditions.evaluate(stage.gate.pass, { result, stage })
            : { passed: false, evidence: "the stage result is not available to the host", judgedBy: "host" as const };
          post(state, { type: "gate_evaluated", stageId: effect.stageId, attempt: effect.attempt, ...verdict });
          break;
        }
        case "interrupt": {
          state.interruptAsked.add(effect.stageId);
          const child = state.live.get(effect.stageId);
          const interrupted = child !== undefined && deps.getRunner()?.interruptRun(child, workBoardOriginSessionId(state.itemId)).ok === true;
          // No child to unwind and none starting: the stage ends here. A starting one ends itself when it sees the request.
          if (!interrupted && child === undefined && !state.starting.has(effect.stageId)) {
            const run = record.stageRuns.find(candidate => candidate.stageId === effect.stageId);
            if (run) post(state, { type: "stage_ended", stageId: run.stageId, attempt: run.attempt, ok: false, interrupted: true });
          }
          break;
        }
        case "seal": {
          const sealed = await workspace.seal(state.ref, effect.stageId).catch((): { ok: false } => ({ ok: false }));
          if (!sealed.ok) {
            sealFailed = true;
            post(state, { type: "seal_failed", stageId: effect.stageId });
          } else if (sealed.sealCommit !== undefined) {
            const sealCommit = sealed.sealCommit;
            await writeRun(state, current => ({
              ...current,
              stageRuns: current.stageRuns.map(run => run.stageId === effect.stageId && run.workspace ? { ...run, workspace: { ...run.workspace, sealCommit } } : run),
            }));
          }
          break;
        }
        case "integrate": {
          // A stage of this step could not be sealed: the join the reducer opened is dropped by `seal_failed`, so nothing is collected.
          if (sealFailed) break;
          try {
            const merged = await workspace.integrate(state.ref, effect.joinId, effect.stageIds);
            post(state, merged.ok ? { type: "join_integrated", joinId: effect.joinId } : { type: "join_conflict", joinId: effect.joinId, conflict: merged.conflict });
          } catch (error) {
            log.warn("stage join failed (id=%d): %s", state.itemId, errorMessage(error));
            fault(state, "join-failed");
          }
          break;
        }
        case "settle":
          // The run file already says so (the write above). The row follows; a crash here is repaired from the record at boot.
          await finish(state, record, effect.runStatus, version, effect.runStatus === "error" ? state.faulted ?? undefined : undefined);
          break;
        case "release_workspace":
          await workspace.release(state.ref, effect.stageIds).catch((error: unknown) => log.warn("stage workspace release failed (id=%d): %s", state.itemId, errorMessage(error)));
          break;
      }
    }
  }

  function inputsOf(version: TemplateVersion, stage: TemplateStage, stageRuns: readonly WorkItemStageRun[]): StageInput[] {
    return stage.inputs.flatMap((id): StageInput[] => {
      const from = version.stages.find(candidate => candidate.id === id);
      const run = stageRuns.find(candidate => candidate.stageId === id);
      if (!from || run?.status !== "passed" || run.output === undefined) return [];
      const gate = from.gate.type === "human" ? "human" : from.gate.pass.kind === "model_verdict" ? "model" : "auto";
      return [{ stageId: id, name: from.name, output: run.output, gate, ...(run.taint ? { taint: "file-content" as const } : {}) }];
    });
  }

  const halted = (state: RunState, stageId: string): boolean =>
    state.stopping || state.faulted !== null || state.refused !== null || state.interruptAsked.has(stageId) || state.revoked.has(stageId);

  /** The only `runner.spawn` call for a template run. Throws `WorkflowInvariantError` unless every check of the plan's table holds. */
  async function spawnStageChild(state: RunState, stageId: string, attempt: number): Promise<{ result: SubAgentSpawnResult; inputTaint: boolean }> {
    const key = `${stageId}#${attempt}`;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_STAGE_ATTEMPTS) throw new WorkflowInvariantError("attempt-out-of-range");
    if (state.stopping) throw new WorkflowInvariantError("run-stopped");
    if (!state.due.delete(key)) throw new WorkflowInvariantError("stage-not-ready");
    if (state.live.has(stageId) || state.starting.has(stageId)) throw new WorkflowInvariantError("duplicate-stage-child");
    state.starting.add(stageId);
    try {
      const record = await records.get(state.itemId, state.runId);
      const got = await store.get(state.itemId);
      // The board row gives the title and the detail the prompt quotes; the pin, the source and the stage runs come from the run file.
      const item = got.status === "found" ? got.item : null;
      if (!item || item.runId !== state.runId) throw new WorkflowInvariantError("run-stopped");
      if (!record || record.settled !== undefined) throw new WorkflowInvariantError("version-missing");
      const pin = record.pin;
      const source = record.runStartedBy;
      let version: TemplateVersion;
      try {
        version = await resolvePinned(pin);
      } catch (error) {
        const fault = pinFault(error);
        if (fault === null) throw error;
        throw new WorkflowInvariantError(fault);
      }
      const stage = version.stages.find(candidate => candidate.id === stageId);
      if (!stage) throw new WorkflowInvariantError("stage-not-in-version");
      const run = record.stageRuns.find(candidate => candidate.stageId === stageId);
      if (run?.status !== "running" || run.attempt !== attempt) throw new WorkflowInvariantError("stage-not-ready");

      const authorise = async (): Promise<Extract<RunAuthorityVerdict, { ok: true }>> => {
        const verdict = await verdictFor("spawn", state.projectRoot, source, pin);
        if (!verdict.ok) throw new WorkflowInvariantError("run-not-authorised", verdict.code, "tool" in verdict ? verdict.tool : undefined);
        return verdict;
      };
      // Asked before anything is prepared, so a refused run prepares nothing, and again at the spawn itself (below).
      const lane = (await authorise()).lane;
      if ((stage.requestedOutputs?.length ?? 0) > 0 && !deps.outputs) throw new WorkflowInvariantError("outputs-unavailable");

      const prepared = await workspace.prepare(state.ref, stage, attempt);
      const runRoot = record.runWorkspace?.runRoot;
      if (!prepared.ok) throw new WorkflowInvariantError("workspace-missing", prepared.code);
      if (runRoot === undefined || !isUnder(runRoot, prepared.workspace.root)) throw new WorkflowInvariantError("workspace-missing");
      const stageRoot = prepared.workspace.root;

      const runKey = state.ref.runKey;
      if (lane === "unattended") {
        const admitted = deps.lane
          ? await deps.lane.admit({ runKey, stageId, envelope: stage.envelope, workspaceRoot: stageRoot })
          : isAllReadOnlyVersion(version) ? { ok: true as const } : { ok: false as const, code: "lane-unavailable" as const };
        if (!admitted.ok) throw new WorkflowInvariantError("lane-blocked", admitted.code);
      }

      const runner = deps.getRunner();
      if (!runner) throw new Error("sub-agent runner not available");
      const profile = stage.agentName ? (await deps.getAgentProfile?.(stage.agentName)) ?? null : null;
      if (stage.agentName && !profile) throw new Error(`agent profile not found: ${stage.agentName}`);
      const readOnly = stage.toolScope === "read";
      const readTools = readOnly ? runner.parentToolRegistry().listAll().filter(tool => requiredTier(tool.category) === "read").map(tool => tool.name) : [];
      const revision = run.gate?.type === "human" && run.gate.status === "changes_requested" && run.gate.note !== undefined && run.output !== undefined
        ? { priorOutput: run.output, note: run.gate.note, ...(run.taint ? { taint: run.taint } : {}) }
        : undefined;
      const gateSuffix = stage.gate.type === "auto" ? deps.passConditions.promptSuffix(stage.gate.pass.kind) : undefined;
      const prompt = buildStagePrompt({
        item, stage, inputs: inputsOf(version, stage, record.stageRuns),
        ...(revision ? { revision } : {}), ...(version.setupCommands ? { setupCommands: version.setupCommands } : {}), ...(gateSuffix ? { gateSuffix } : {}),
      });
      const stored = await writeRun(state, current => ({
        ...current,
        stageRuns: current.stageRuns.map(candidate => candidate.stageId === stageId && candidate.attempt === attempt ? { ...candidate, workspace: { ...prepared.workspace } } : candidate),
      }));
      if (stored.run === null) throw new WorkflowInvariantError(stored.reason === "row-gone" ? "run-stopped" : "version-missing");

      // The spawn boundary. Preparing took time: the run's source is asked again, and a stop, a refusal or a fault that arrived meanwhile
      // ends the launch here. Nothing is awaited between these checks and the spawn.
      if ((await authorise()).lane !== lane) throw new WorkflowInvariantError("run-not-authorised", "source-not-authorised");
      if (halted(state, stageId)) throw new WorkflowInvariantError("run-stopped");

      let linked: string | undefined;
      try {
        const result = await runner.spawn(
          {
            title: `${stage.name}: ${item.title}`,
            instructions: prompt.instructions,
            toolScope: readOnly ? exactToolScope(readTools) : PARENT_ALL_TOOL_SCOPE,
            originSessionId: workBoardOriginSessionId(state.itemId),
            projectRoot: stageRoot,
            ...(item.projectName ? { projectName: item.projectName } : {}),
            profileMode: readOnly ? "plan" : "execute",
            profileModel: profile?.model,
            ...(readOnly ? { maxRounds: READ_STAGE_ROUND_BUDGET } : {}),
            ...(prompt.taint ? { hostInputTaint: prompt.taint } : {}),
            ...(lane === "unattended" ? { unattendedStage: { runKey, stageId } } : {}),
          },
          {
            onLinked: ({ childSessionId }) => {
              linked = childSessionId;
              state.live.set(stageId, childSessionId);
              state.starting.delete(stageId);
              // A stop, a rejection or a revocation that arrived while the child was starting reaches it here.
              if (state.stopping || state.faulted !== null || state.interruptAsked.has(stageId) || state.revoked.has(stageId)) runner.interruptRun(childSessionId, workBoardOriginSessionId(state.itemId));
              deps.runScope?.sessionLinked(runKey, childSessionId);
              if (lane === "unattended" && stage.envelope) deps.lane?.sessionLinked({ runKey, stageId, sessionId: childSessionId, envelope: stage.envelope, workspaceRoot: stageRoot });
              emit({ itemId: state.itemId, phase: "executing", stageId, attempt, runSessionId: childSessionId });
              post(state, { type: "stage_linked", stageId, childSessionId });
            },
            onError: (message) => {
              if (!state.stopping && !state.interruptAsked.has(stageId)) emit({ itemId: state.itemId, phase: "stage_failed", stageId, attempt, message });
            },
          },
        );
        return { result, inputTaint: prompt.taint !== undefined };
      } finally {
        state.live.delete(stageId);
        if (linked !== undefined) {
          deps.runScope?.sessionEnded(linked);
          if (lane === "unattended") deps.lane?.sessionEnded(linked);
        }
      }
    } finally {
      state.starting.delete(stageId);
    }
  }

  function failureOf(state: RunState, stageId: string, result: SubAgentSpawnResult): StageFailure {
    if (state.revoked.has(stageId)) return "workspace-revoked";
    if (result.stopReason === "interrupted") return "interrupted";
    // A tool asked for approval and nobody could answer it (no approval surface): the stage fails and its gate never opens.
    return result.stopReason === "authorization-required" || result.authorizationRequired !== undefined ? "denied-tool" : "error";
  }

  async function launch(state: RunState, stageId: string, attempt: number): Promise<void> {
    let next: RunEvent | null = null;
    let faultCause: string | null = null;
    try {
      const { result, inputTaint } = await spawnStageChild(state, stageId, attempt);
      state.results.set(stageId, result);
      // A child that reports no end origin is treated as having read files: an unknown origin never passes as clean.
      const end = result.endTrustOrigin;
      const taint: WorkItemStageRun["taint"] = end === "agent-message" ? "agent-message"
        : inputTaint || end === undefined || end === "file-content" ? "file-content" : undefined;
      next = {
        type: "stage_ended", stageId, attempt, ok: result.ok, ...(taint ? { taint } : {}),
        ...(result.ok ? { output: result.summary.slice(0, STAGE_OUTPUT_MAX_CHARS) } : { reason: result.error ?? result.summary, failure: failureOf(state, stageId, result) }),
        ...(result.stopReason === "interrupted" ? { interrupted: true } : {}),
      };
    } catch (error) {
      if (error instanceof WorkflowInvariantError && error.code === "run-not-authorised") {
        state.refused ??= { code: error.reasonCode ?? error.code, ...(error.reasonTool ? { tool: error.reasonTool } : {}) };
        next = { type: "spawn_refused", stageId, attempt };
      } else if (error instanceof WorkflowInvariantError && (error.code === "version-missing" || error.code === "graph-mismatch")) {
        faultCause = error.code;
      } else if (error instanceof WorkflowInvariantError && error.code === "lane-blocked") {
        const code = error.reasonCode as LaneBlockCode;
        await writeRun(state, current => ({
          ...current,
          stageRuns: current.stageRuns.map(run => run.stageId === stageId ? { ...run, blocked: { code, at: new Date().toISOString() } } : run),
        })).catch(() => undefined);
        next = { type: "stage_ended", stageId, attempt, ok: false, reason: error.message, failure: "error" };
      } else {
        const stopped = error instanceof WorkflowInvariantError && error.code === "run-stopped";
        if (!stopped) log.warn("stage child did not start (id=%d, stage=%s): %s", state.itemId, stageId, errorMessage(error));
        const failure: StageFailure = state.revoked.has(stageId) ? "workspace-revoked"
          : stopped ? "interrupted"
          : error instanceof WorkflowInvariantError && error.code === "workspace-missing" && error.reasonCode?.startsWith("seed") ? "seed" : "error";
        next = { type: "stage_ended", stageId, attempt, ok: false, reason: errorMessage(error), failure, ...(stopped ? { interrupted: true } : {}) };
      }
    } finally {
      state.due.delete(`${stageId}#${attempt}`);
      state.interruptAsked.delete(stageId);
      state.revoked.delete(stageId);
      // The launch is over before its end event is handled: a run is idle exactly when no launch is counted.
      state.busy -= 1;
      if (faultCause !== null) state.faulted ??= faultCause;
      // The stage of a faulted launch has no child: its end is reported so the run can unwind.
      if (faultCause !== null) post(state, { type: "stage_ended", stageId, attempt, ok: false, interrupted: true });
      else if (next !== null) post(state, next);
      wake(state);
    }
  }

  async function idle(state: RunState): Promise<void> {
    for (;;) {
      const chain = state.chain;
      await chain;
      if (state.chain !== chain) continue;
      if (state.busy === 0 || runs.get(state.itemId) !== state) return;
      await new Promise<void>(resolve => { state.waiters.add(resolve); });
    }
  }

  async function resultOf(state: RunState): Promise<WorkItemRunResult> {
    const record = await records.get(state.itemId, state.runId);
    if (!record) return state.rowGone ? { status: "cancelled", reason: "item-removed" } : { status: "not_found" };
    const got = await store.get(state.itemId);
    const runStatus = record.settled?.status;
    const output = got.status === "found" && got.item.runId === state.runId ? got.item.output : undefined;
    const reason = state.refused ? { reasonCode: state.refused.code, reason: state.refused.code, ...(state.refused.tool ? { reasonTool: state.refused.tool } : {}) } : {};
    if (runStatus === "completed") return { status: "completed", ...(output !== undefined ? { output } : {}) };
    if (runStatus === "denied" || runStatus === "error") return { status: runStatus };
    if (runStatus === "cancelled") return { status: "cancelled", ...(state.stopping ? { reason: state.rowGone ? "item-removed" : "user-stopped" } : reason) };
    // Unsettled with nothing live: the run waits for the user (a gate, a join, Retry or Stop).
    return { status: "awaiting_approval" };
  }

  async function start(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<WorkItemRunResult> {
    try {
      // A run a restart left unsettled is taken over first: a start never races its adoption, and never replaces such a run.
      await adopted();
      if (runs.has(itemId)) return { status: "already_running", reason: `Work item #${itemId} is already running a template run.` };
      return await startRun(itemId, item, a);
    } finally {
      // A refused start never opened a run; the caller's in-flight mark goes with it.
      if (!runs.has(itemId)) deps.releaseItem(itemId);
    }
  }

  async function startRun(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<WorkItemRunResult> {
    const refused = (code: string, tool?: EnvelopeToolRef): WorkItemRunResult => ({ status: "error", reason: code, reasonCode: code, ...(tool ? { reasonTool: tool } : {}) });
    const source = a.source;
    const pin = source.pin;
    let version: TemplateVersion;
    let projectRoot: string | undefined;
    try {
      // A refusal writes nothing. The run's project is resolved by the host: the authorised registry root of the project on the card,
      // or the snapshot the schedule was approved for. The board row's project is never the run's.
      if (source.kind === "local-create-and-run" && source.projectRoot !== undefined) {
        const registered = deps.resolveProjectRoot(source.projectRoot);
        if (registered === null) return refused("scope-not-authorised");
        if (registered !== source.projectRoot) return refused("project-mismatch");
      }
      projectRoot = await runProjectOf(source);
      const verdict = await verdictFor("start", projectRoot, source, pin);
      if (!verdict.ok) return refused(verdict.code, "tool" in verdict ? verdict.tool : undefined);
      // A row that names another project is refused; it is compared, never used.
      if (item.projectRoot !== projectRoot) return refused("project-mismatch");
      version = await resolvePinned(pin);
      stepsOf(version);
    } catch (error) {
      const fault = pinFault(error);
      return fault ? refused(fault) : { status: "error", reason: errorMessage(error) };
    }
    if (!deps.outputs && version.stages.some(stage => (stage.requestedOutputs?.length ?? 0) > 0)) return refused("outputs-unavailable");

    const runId = randomUUID();
    const ref: RunRef = { itemId, runId, runKey: runKeyOf(itemId, runId) };
    const opened = await workspace.open(ref, projectRoot);
    if (!opened.ok) return refused(opened.code);
    const startedAt = new Date().toISOString();
    let recorded = false;
    try {
      const stageRuns = version.stages.map((stage): WorkItemStageRun => ({ stageId: stage.id, attempt: 1, status: "waiting" }));
      // The run file gets the pin, the source and the stage runs first; the board row then names the run by its id and nothing else.
      const begun = await records.begin(itemId, runId, startedAt, { templateId: pin.templateId, version: pin.version, graphHash: pin.graphHash, source, stageRuns });
      if (begun.status !== "updated") return await abandonStart(ref, false, refused(begun.status === "invalid" ? begun.reason : begun.status));
      recorded = true;
      const placed = await records.update(itemId, runId, current => ({ ...current, runWorkspace: opened.workspace }));
      if (!placed.ok) throw new Error("the run workspace could not be stored");
      const shown = await store.setRunStatus(itemId, "executing");
      if (shown.status !== "updated") throw new Error("the run could not be shown on the board");
    } catch (error) {
      const code = error instanceof WorkflowTemplateError ? error.code : undefined;
      return abandonStart(ref, recorded, code ? refused(code) : { status: "error", reason: errorMessage(error) });
    }
    const state = openState(itemId, runId, projectRoot, a.approvalSurface);
    emit({ itemId, phase: "executing" });
    post(state, { type: "started" });
    await idle(state);
    return resultOf(state);
  }

  /** A start that failed after its workspace was opened: the workspace goes, and a run that was already stored ends `error`. */
  async function abandonStart(ref: RunRef, recorded: boolean, result: WorkItemRunResult): Promise<WorkItemRunResult> {
    if (recorded) {
      const at = new Date().toISOString();
      await records.update(ref.itemId, ref.runId, current => ({ ...current, settled: { status: "error", at } })).catch(() => undefined);
      await showOnRow(ref.itemId, "error", undefined);
    }
    await workspace.release(ref, "all").catch(() => undefined);
    return result;
  }

  /** A user action on an unsettled run: refused before any write unless `precheck` passes and the pin still resolves. */
  async function decide<R extends string>(itemId: number, runId: string, surface: WebContents | null, event: RunEvent, precheck: Precheck<R>): Promise<R | PinRefusal | "run_mismatch" | "not_found" | "not_pending" | null> {
    await adopted();
    const got = await store.get(itemId);
    if (got.status !== "found") return "not_found";
    if (got.item.runId !== runId) return "run_mismatch";
    const record = await records.get(itemId, runId);
    if (!record) return "run_mismatch";
    const state = await stateFor(record, surface);
    if (!state) return "not_pending";
    return enqueue(state, () => handle(state, event, precheck));
  }

  function noteRefusal(i: StageGateDecideInput): "note_required" | "note_too_long" | "note_invalid" | null {
    const note = i.note ?? "";
    if (i.decision === "request_changes" && note.trim().length === 0) return "note_required";
    if (note.length > MAX_PLAN_NOTE_LENGTH) return "note_too_long";
    return hasUnsafeDirectiveControlChars(note) ? "note_invalid" : null;
  }

  const decidable = (itemId: number): boolean => {
    const state = runs.get(itemId);
    return state !== undefined && !state.stopping && state.refused === null && state.faulted === null;
  };

  async function decideGate(itemId: number, i: StageGateDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageGateDecideResult> {
    const event: RunEvent = { type: "gate_decided", stageId: i.stageId, attempt: i.attempt, decision: i.decision, ...(i.note !== undefined && i.note.length > 0 ? { note: i.note } : {}) };
    const reason = await decide(itemId, i.runId, o.approvalSurface, event, (record) => {
      const run = record.stageRuns.find(candidate => candidate.stageId === i.stageId);
      if (!run) return "not_found";
      if (run.attempt !== i.attempt) return "attempt_mismatch";
      if (run.status !== "awaiting_gate" || run.gate?.type !== "human" || run.gate.status !== "pending" || !decidable(itemId)) return "not_pending";
      if (run.output === undefined || run.resultHash === undefined || resultHashOf(run.output) !== run.resultHash || i.resultHash !== run.resultHash) return "result_mismatch";
      if ((run.requestedOutputs?.length ?? 0) > 0 && i.outputHash !== outputHashOf(run.output, run.requestedOutputs ?? [])) return "output_mismatch";
      const note = noteRefusal(i);
      if (note) return note;
      return i.decision === "request_changes" && run.attempt >= MAX_STAGE_ATTEMPTS ? "attempts_exhausted" : null;
    });
    if (reason !== null) return { ok: false, reason };
    return { ok: true, status: i.decision === "approve" ? "approved" : i.decision === "reject" ? "rejected" : "changes_requested" };
  }

  async function decideJoin(itemId: number, i: StageJoinDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageJoinDecideResult> {
    const reason = await decide(itemId, i.runId, o.approvalSurface, { type: "join_decided", joinId: i.joinId, decision: i.decision }, (record) => {
      const join = (record.stageJoins ?? []).find(candidate => candidate.joinId === i.joinId);
      if (!join) return "not_found";
      if (join.status !== "conflict" || !join.conflict || !decidable(itemId)) return "not_pending";
      return join.conflict.conflictHash === i.conflictHash ? null : "conflict_mismatch";
    });
    return reason === null ? { ok: true } : { ok: false, reason };
  }

  async function retryStage(itemId: number, i: { runId: string; stageId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult> {
    const reason = await decide(itemId, i.runId, o.approvalSurface, { type: "retry_requested", stageId: i.stageId }, (record) => {
      const run = record.stageRuns.find(candidate => candidate.stageId === i.stageId);
      if (!run) return "not_found";
      if (run.status !== "failed" || !decidable(itemId)) return "not_pending";
      return run.attempt >= MAX_STAGE_ATTEMPTS ? "attempts_exhausted" : null;
    });
    return reason === null ? { ok: true } : { ok: false, reason };
  }

  async function continueRun(itemId: number, i: { runId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult> {
    const reason = await decide(itemId, i.runId, o.approvalSurface, { type: "continue_requested" }, () => {
      const state = runs.get(itemId);
      if (!state || !decidable(itemId)) return "not_pending";
      return state.live.size > 0 || state.busy > 0 ? "not_idle" : null;
    });
    return reason === null ? { ok: true } : { ok: false, reason };
  }

  function stop(itemId: number): WorkBoardCancelResult {
    const state = runs.get(itemId);
    if (!state) return { ok: false, reason: "not-executing" };
    // A second stop while the first unwinds is the same stop.
    if (state.stopping) return { ok: true };
    state.stopping = true;
    post(state, { type: "stop_requested" });
    return { ok: true };
  }

  function steer(itemId: number, stageId: string, text: string): WorkBoardSteerResult {
    const state = runs.get(itemId);
    const child = state?.live.get(stageId);
    const runner = deps.getRunner();
    if (child === undefined || !runner) return { ok: false, reason: "not-executing" };
    let messageId: string | undefined;
    const report = (ack: WorkBoardSteerAck): void => emit({ itemId, phase: "executing", stageId, steer: ack });
    const queued = runner.queueHostDirectiveToWorkBoardChild(workBoardOriginSessionId(itemId), child, text, {
      onInjected: () => { if (messageId !== undefined) report({ messageId, status: "delivered", turn: 0 }); },
      onDropped: (reason) => { if (messageId !== undefined) report({ messageId, status: "dropped", reason }); },
    });
    if (!queued.ok) return { ok: false, reason: queued.reason };
    messageId = queued.messageId;
    return { ok: true, messageId };
  }

  function projectRootRevoked(canonicalRoot: string): void {
    const revoked = rootKey(canonicalRoot);
    for (const state of runs.values()) {
      if (state.projectRoot === undefined) continue;
      const root = rootKey(state.projectRoot);
      if (root !== revoked && !root.startsWith(`${revoked}/`)) continue;
      for (const stageId of state.starting) state.revoked.add(stageId);
      for (const [stageId, child] of state.live) {
        state.revoked.add(stageId);
        deps.getRunner()?.interruptRun(child, workBoardOriginSessionId(state.itemId));
      }
    }
  }

  /** Boot. The run file is the truth: a row whose run is over is shown as the record says (the process may have died between the two
   * writes, and the board's own reconcile fails every row it finds running); an unsettled run is parked and taken over. */
  async function adoptRuns(): Promise<void> {
    const active: string[] = [];
    for (const { item, run } of await records.named()) {
      // Unreadable, awaiting review or another row's: the row already says so, and nothing is adopted.
      if (!run) continue;
      if (run.settled !== undefined) {
        if (item.runStatus !== run.settled.status) {
          const version = run.settled.status === "completed" ? await resolvePinned(run.pin).catch(() => null) : null;
          await showOnRow(item.id, run.settled.status, finalOutput(run, version));
          emit({ itemId: item.id, phase: run.settled.status === "completed" ? "done" : run.settled.status, message: "restored" });
          deps.itemChanged?.(item.id);
        }
        continue;
      }
      const now = new Date().toISOString();
      const parked = await reconcileRunRecord(run, now, root => access(root).then(() => true, () => false));
      let record = run;
      if (parked) {
        const stored = await records.update(item.id, run.runId, current => current.settled === undefined ? parked : null);
        if (!stored.ok) continue;
        record = stored.run;
      }
      // This run is not lost: it waits for the user. The row and its history entry say so again.
      if (item.runStatus !== "executing") await store.setRunResult(item.id, { runStatus: "executing" });
      active.push(record.runId);
      await stateFor(record, null);
      emit({ itemId: item.id, phase: "executing", message: "resumed" });
      deps.itemChanged?.(item.id);
    }
    await workspace.sweep(active).catch((error: unknown) => log.warn("stage workspace sweep failed: %s", errorMessage(error)));
  }

  /** Once per process; a failed attempt is tried again by the next caller, which is refused until one succeeds. */
  const adopted = (): Promise<void> => adoption ??= adoptRuns().catch((error: unknown) => { adoption = null; throw error; });

  /** What a board reader is told about each row's template run, from the run file and the host's own state. Whatever a row itself says
   * under that name is dropped first. */
  async function projectRuns<T extends WorkItemResolved>(items: readonly T[]): Promise<T[]> {
    const named = items.some(item => item.templateId !== undefined && item.runId !== undefined);
    const runOf = named ? await records.view().catch(() => null) : null;
    return items.map((item) => {
      const clean = { ...item };
      delete clean.templateRunState;
      const run = item.templateId !== undefined ? runOf?.(item) ?? null : null;
      if (!run) return clean;
      const state = runs.get(item.id);
      const owned = state?.runId === run.runId;
      // Over in the run file: that is how it ended, whatever a row not yet restored after a crash says.
      if (run.settled !== undefined) return owned ? clean : { ...clean, runStatus: run.settled.status };
      // Unsettled and not yet taken over after a restart: it is resuming, never an error.
      if (!owned) return { ...clean, runStatus: "executing", templateRunState: "resuming" };
      return { ...clean, runStatus: "executing", templateRunState: isAwaitingStageReview(run) ? "awaiting_review" : "running" };
    });
  }

  return {
    start, decideGate, decideJoin, retryStage, continueRun, projectRootRevoked, steer, stop, projectRuns,
    adoptParkedRuns: adopted,
    liveStageSessions: itemId => new Map(runs.get(itemId)?.live ?? []),
    whenIdle: async (itemId) => { const state = runs.get(itemId); if (state) await idle(state); },
  };
}
