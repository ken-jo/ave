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
  type WorkBoardCancelResult, type WorkBoardRunEvent, type WorkBoardSteerAck, type WorkBoardSteerResult, type WorkItem, type WorkItemRunResult,
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
import { reconcileRunRecord, type RunRecord, type WorkflowRunState } from "./run-state.js";
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
  store: WorkBoardStore;
  /** Every run-authority field: the pin, the source, the stage runs, the joins, the gates and their hashes. */
  runs: WorkflowRunState;
  templates: Pick<WorkflowTemplateStore, "get" | "resolveVersion">;
  attachments: Pick<WorkflowTemplateStore, "getAttachment" | "listByTemplate" | "listByRoutine">;
  getRunner: () => SubAgentRunner | undefined;
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  emit: (e: Omit<WorkBoardRunEvent, "at">) => void;
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
  /** Boot: take over the runs a restart left unsettled (so Stop reaches them) and sweep the workspaces no run owns. Spawns nothing. */
  adoptParkedRuns(): Promise<void>;
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
      stopping: false, refused: null, live: new Map(), due: new Set(), starting: new Set(), interruptAsked: new Set(), revoked: new Set(), results: new Map(),
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

  /** The state of an unsettled run, created on demand for a run a restart left parked. */
  function stateFor(record: RunRecord, surface: WebContents | null): RunState | null {
    if (record.status !== "executing") return null;
    const known = runs.get(record.itemId);
    if (known?.runId === record.runId) {
      if (surface !== null && surface !== known.surface) {
        known.surface = surface;
        updateApprovalSurface({ kind: "attach", sessionId: workBoardOriginSessionId(record.itemId), surface });
      }
      return known;
    }
    return openState(record.itemId, record.runId, record.projectRoot, surface);
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

  async function settle(state: RunState, record: RunRecord, runStatus: "completed" | "denied" | "error" | "cancelled", version: TemplateVersion | null, message?: string): Promise<void> {
    const lastStage = version ? stepsOf(version).at(-1)?.at(-1) : undefined;
    const output = runStatus === "completed" ? record.stageRuns.find(run => run.stageId === lastStage)?.output : undefined;
    // The run file first: it is what says the run is over. The board row then shows it.
    await records.update(state.runId, current => ({ ...current, status: runStatus, updatedAt: new Date().toISOString() }));
    await store.setRunResult(state.itemId, { runStatus, ...(output !== undefined ? { output } : {}) });
    const reason = state.refused && runStatus === "cancelled"
      ? { reasonCode: state.refused.code, ...(state.refused.tool ? { reasonTool: state.refused.tool } : {}) }
      : {};
    if (state.refused && runStatus === "cancelled") {
      deps.audit?.({ itemId: state.itemId, runId: state.runId, event: "work-run:authority-refused", code: state.refused.code, ...(state.refused.tool ? { tool: state.refused.tool } : {}) });
    }
    const phase = runStatus === "completed" ? "done" : runStatus;
    emit({ itemId: state.itemId, phase, ...(message ? { message } : state.stopping && runStatus === "cancelled" ? { message: "user-stopped" } : {}), ...reason });
    closeState(state);
  }

  /** One event: read the run, check it, reduce, one write of the run, then the effects. `precheck` refuses a user decision before
   * anything is written; the pin is checked after it and before the reducer. */
  async function handle<R extends string = never>(state: RunState, event: RunEvent, precheck?: Precheck<R>): Promise<R | PinRefusal | "run_mismatch" | "not_found" | null> {
    const record = await records.get(state.runId);
    const got = await store.get(state.itemId);
    if (!record || got.status !== "found") return "not_found";
    // The board row names its run by id only; an event of a run the row no longer names is dropped.
    if (got.item.runId !== state.runId || record.itemId !== state.itemId || runs.get(state.itemId) !== state) {
      log.warn("dropped a stage event of another run (id=%d, event=%s)", state.itemId, event.type);
      return "run_mismatch";
    }
    if (record.status !== "executing") return "run_mismatch";
    const refusal = precheck?.(record) ?? null;
    if (refusal !== null) return refusal;
    let version: TemplateVersion;
    try {
      version = await resolvePinned(record.pin);
      stepsOf(version);
    } catch (error) {
      const fault = pinFault(error);
      // A user decision against an unreadable pin is refused and changes nothing; a scheduler event fails the run.
      if (precheck && fault !== null) return fault === "version-missing" ? "version_missing" : "graph_mismatch";
      await settle(state, record, "error", null, fault ?? errorMessage(error));
      return null;
    }

    const before = record.stageRuns;
    const now = new Date().toISOString();
    const step = reduceRun({ graph: version, stageRuns: before, joins: record.stageJoins, stopping: state.stopping, refused: state.refused !== null, now }, event);
    const written = await records.update(state.runId, current => ({ ...current, stageRuns: step.stageRuns, stageJoins: step.joins, updatedAt: now }));
    if (written === null) {
      log.warn("stage run write refused (id=%d, event=%s)", state.itemId, event.type);
      return "run_mismatch";
    }
    for (const run of step.stageRuns) {
      const prior = before.find(candidate => candidate.stageId === run.stageId);
      if (prior?.status === run.status && prior.attempt === run.attempt) continue;
      const about = { itemId: state.itemId, stageId: run.stageId, attempt: run.attempt };
      if (run.status === "awaiting_gate") emit({ ...about, phase: "stage_gate" });
      else if (run.status === "passed") emit({ ...about, phase: "stage_passed" });
      else if (run.status === "failed") emit({ ...about, phase: "stage_failed", ...(run.failure ? { message: run.failure } : {}) });
    }
    await runEffects(state, { ...record, stageRuns: step.stageRuns, stageJoins: step.joins }, version, step.effects);
    return null;
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
            await records.update(state.runId, current => ({
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
            post(state, { type: "fault" });
          }
          break;
        }
        case "settle":
          await settle(state, record, effect.runStatus, version);
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

  /** The only `runner.spawn` call for a template run. Throws `WorkflowInvariantError` unless every check of the plan's table holds. */
  async function spawnStageChild(state: RunState, stageId: string, attempt: number): Promise<{ result: SubAgentSpawnResult; inputTaint: boolean }> {
    const key = `${stageId}#${attempt}`;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_STAGE_ATTEMPTS) throw new WorkflowInvariantError("attempt-out-of-range");
    if (state.stopping) throw new WorkflowInvariantError("run-stopped");
    if (!state.due.delete(key)) throw new WorkflowInvariantError("stage-not-ready");
    if (state.live.has(stageId) || state.starting.has(stageId)) throw new WorkflowInvariantError("duplicate-stage-child");
    state.starting.add(stageId);
    try {
      const record = await records.get(state.runId);
      const got = await store.get(state.itemId);
      // The board row gives the title and the detail the prompt quotes; the pin, the source and the stage runs come from the run file.
      const item = got.status === "found" ? got.item : null;
      if (!record || !item || item.runId !== state.runId || record.itemId !== state.itemId) throw new WorkflowInvariantError("version-missing");
      const pin = record.pin;
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

      const verdict = await verdictFor("spawn", record.projectRoot, record.startedBy, pin);
      if (!verdict.ok) throw new WorkflowInvariantError("run-not-authorised", verdict.code, "tool" in verdict ? verdict.tool : undefined);
      if ((stage.requestedOutputs?.length ?? 0) > 0 && !deps.outputs) throw new WorkflowInvariantError("outputs-unavailable");

      const prepared = await workspace.prepare(state.ref, stage, attempt);
      const runRoot = record.workspace?.runRoot;
      if (!prepared.ok) throw new WorkflowInvariantError("workspace-missing", prepared.code);
      if (runRoot === undefined || !isUnder(runRoot, prepared.workspace.root)) throw new WorkflowInvariantError("workspace-missing");
      const stageRoot = prepared.workspace.root;

      const runKey = state.ref.runKey;
      if (verdict.lane === "unattended") {
        const admitted = deps.lane
          ? await deps.lane.admit({ runKey, stageId, envelope: stage.envelope, workspaceRoot: stageRoot })
          : isAllReadOnlyVersion(version) ? { ok: true as const } : { ok: false as const, code: "lane-unavailable" as const };
        if (!admitted.ok) throw new WorkflowInvariantError("lane-blocked", admitted.code);
      }
      if (state.stopping || state.interruptAsked.has(stageId) || state.revoked.has(stageId)) throw new WorkflowInvariantError("run-stopped");

      const runner = deps.getRunner();
      if (!runner) throw new Error("sub-agent runner not available");
      const profile = stage.agentName ? (await deps.getAgentProfile?.(stage.agentName)) ?? null : null;
      if (stage.agentName && !profile) throw new Error(`agent profile not found: ${stage.agentName}`);
      const readOnly = stage.toolScope === "read";
      const readTools = readOnly ? runner.parentToolRegistry().listAll().filter(tool => requiredTier(tool.category) === "read").map(tool => tool.name) : [];
      const revision = run.gate?.type === "human" && run.gate.status === "changes_requested" && run.gate.note !== undefined && run.output !== undefined
        ? { priorOutput: run.output, note: run.gate.note }
        : undefined;
      const gateSuffix = stage.gate.type === "auto" ? deps.passConditions.promptSuffix(stage.gate.pass.kind) : undefined;
      const prompt = buildStagePrompt({
        item, stage, inputs: inputsOf(version, stage, record.stageRuns),
        ...(revision ? { revision } : {}), ...(version.setupCommands ? { setupCommands: version.setupCommands } : {}), ...(gateSuffix ? { gateSuffix } : {}),
      });
      await records.update(state.runId, current => ({
        ...current,
        stageRuns: current.stageRuns.map(candidate => candidate.stageId === stageId && candidate.attempt === attempt ? { ...candidate, workspace: { ...prepared.workspace } } : candidate),
      }));

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
            ...(verdict.lane === "unattended" ? { unattendedStage: { runKey, stageId } } : {}),
          },
          {
            onLinked: ({ childSessionId }) => {
              linked = childSessionId;
              state.live.set(stageId, childSessionId);
              state.starting.delete(stageId);
              // A stop, a rejection or a revocation that arrived while the child was starting reaches it here.
              if (state.stopping || state.interruptAsked.has(stageId) || state.revoked.has(stageId)) runner.interruptRun(childSessionId, workBoardOriginSessionId(state.itemId));
              deps.runScope?.sessionLinked(runKey, childSessionId);
              if (verdict.lane === "unattended" && stage.envelope) deps.lane?.sessionLinked({ runKey, stageId, sessionId: childSessionId, envelope: stage.envelope, workspaceRoot: stageRoot });
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
          if (verdict.lane === "unattended") deps.lane?.sessionEnded(linked);
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
    try {
      const { result, inputTaint } = await spawnStageChild(state, stageId, attempt);
      state.results.set(stageId, result);
      // A child that reports no end origin is treated as having read files: an unknown origin never passes as clean.
      const end = result.endTrustOrigin;
      const taint: WorkItemStageRun["taint"] = end === "agent-message" ? "agent-message"
        : inputTaint || end === undefined || end === "file-content" ? "file-content" : undefined;
      post(state, {
        type: "stage_ended", stageId, attempt, ok: result.ok, ...(taint ? { taint } : {}),
        ...(result.ok ? { output: result.summary.slice(0, STAGE_OUTPUT_MAX_CHARS) } : { reason: result.error ?? result.summary, failure: failureOf(state, stageId, result) }),
        ...(result.stopReason === "interrupted" ? { interrupted: true } : {}),
      });
    } catch (error) {
      if (error instanceof WorkflowInvariantError && error.code === "run-not-authorised") {
        state.refused ??= { code: error.reasonCode ?? error.code, ...(error.reasonTool ? { tool: error.reasonTool } : {}) };
        post(state, { type: "spawn_refused", stageId, attempt });
      } else if (error instanceof WorkflowInvariantError && (error.code === "version-missing" || error.code === "graph-mismatch")) {
        post(state, { type: "fault" });
      } else if (error instanceof WorkflowInvariantError && error.code === "lane-blocked") {
        const code = error.reasonCode as LaneBlockCode;
        await records.update(state.runId, current => ({
          ...current,
          stageRuns: current.stageRuns.map(run => run.stageId === stageId ? { ...run, blocked: { code, at: new Date().toISOString() } } : run),
        })).catch(() => undefined);
        post(state, { type: "stage_ended", stageId, attempt, ok: false, reason: error.message, failure: "error" });
      } else {
        const stopped = error instanceof WorkflowInvariantError && error.code === "run-stopped";
        if (!stopped) log.warn("stage child did not start (id=%d, stage=%s): %s", state.itemId, stageId, errorMessage(error));
        const failure: StageFailure = state.revoked.has(stageId) ? "workspace-revoked"
          : stopped ? "interrupted"
          : error instanceof WorkflowInvariantError && error.code === "workspace-missing" && error.reasonCode?.startsWith("seed") ? "seed" : "error";
        post(state, { type: "stage_ended", stageId, attempt, ok: false, reason: errorMessage(error), failure, ...(stopped ? { interrupted: true } : {}) });
      }
    } finally {
      state.due.delete(`${stageId}#${attempt}`);
      state.interruptAsked.delete(stageId);
      state.revoked.delete(stageId);
      state.busy -= 1;
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
    const record = await records.get(state.runId);
    if (!record) return { status: "not_found" };
    const got = await store.get(state.itemId);
    const runStatus = record.status;
    const output = got.status === "found" && got.item.runId === state.runId ? got.item.output : undefined;
    const reason = state.refused ? { reasonCode: state.refused.code, reason: state.refused.code, ...(state.refused.tool ? { reasonTool: state.refused.tool } : {}) } : {};
    if (runStatus === "completed") return { status: "completed", ...(output !== undefined ? { output } : {}) };
    if (runStatus === "denied" || runStatus === "error") return { status: runStatus };
    if (runStatus === "cancelled") return { status: "cancelled", ...(state.stopping ? { reason: "user-stopped" } : reason) };
    // Unsettled with nothing live: the run waits for the user (a gate, a join, Retry or Stop).
    return { status: "awaiting_approval" };
  }

  async function start(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<WorkItemRunResult> {
    try {
      return await startRun(itemId, item, a);
    } finally {
      // A refused start never opened a run; the caller's in-flight mark goes with it.
      if (!runs.has(itemId)) deps.releaseItem(itemId);
    }
  }

  async function startRun(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<WorkItemRunResult> {
    const refused = (code: string, tool?: EnvelopeToolRef): WorkItemRunResult => ({ status: "error", reason: code, reasonCode: code, ...(tool ? { reasonTool: tool } : {}) });
    const pin = a.source.pin;
    let version: TemplateVersion;
    try {
      // A refusal writes nothing.
      const verdict = await verdictFor("start", item.projectRoot, a.source, pin);
      if (!verdict.ok) return refused(verdict.code, "tool" in verdict ? verdict.tool : undefined);
      version = await resolvePinned(pin);
      stepsOf(version);
    } catch (error) {
      const fault = pinFault(error);
      return fault ? refused(fault) : { status: "error", reason: errorMessage(error) };
    }
    if (!deps.outputs && version.stages.some(stage => (stage.requestedOutputs?.length ?? 0) > 0)) return refused("outputs-unavailable");

    const runId = randomUUID();
    const ref: RunRef = { itemId, runId, runKey: runKeyOf(itemId, runId) };
    const opened = await workspace.open(ref, item.projectRoot);
    if (!opened.ok) return refused(opened.code);
    const startedAt = new Date().toISOString();
    let recorded = false;
    try {
      const stageRuns = version.stages.map((stage): WorkItemStageRun => ({ stageId: stage.id, attempt: 1, status: "waiting" }));
      await records.begin({
        runId, itemId, pin: { templateId: pin.templateId, version: pin.version, graphHash: pin.graphHash }, startedBy: a.source,
        ...(item.projectRoot !== undefined ? { projectRoot: item.projectRoot } : {}),
        status: "executing", stageRuns, stageJoins: [], workspace: opened.workspace, startedAt, updatedAt: startedAt,
      });
      recorded = true;
      // The board row gets the run id and the status it shows, nothing the run is decided from.
      const begun = await store.beginRun(itemId, runId, startedAt);
      if (begun.status !== "updated") throw new Error(begun.status === "invalid" ? begun.reason : begun.status);
      const shown = await store.setRunStatus(itemId, "executing");
      if (shown.status !== "updated") throw new Error("the run could not be shown on the board");
    } catch (error) {
      if (recorded) await records.update(runId, current => ({ ...current, status: "error", updatedAt: new Date().toISOString() })).catch(() => null);
      await workspace.release(ref, "all").catch(() => undefined);
      const code = error instanceof WorkflowTemplateError ? error.code : undefined;
      return code ? refused(code) : { status: "error", reason: errorMessage(error) };
    }
    const state = openState(itemId, runId, item.projectRoot, a.approvalSurface);
    emit({ itemId, phase: "executing" });
    post(state, { type: "started" });
    await idle(state);
    return resultOf(state);
  }

  /** A user action on an unsettled run: refused before any write unless `precheck` passes and the pin still resolves. */
  async function decide<R extends string>(itemId: number, runId: string, surface: WebContents | null, event: RunEvent, precheck: Precheck<R>): Promise<R | PinRefusal | "run_mismatch" | "not_found" | "not_pending" | null> {
    const got = await store.get(itemId);
    if (got.status !== "found") return "not_found";
    const record = await records.get(runId);
    if (!record || record.itemId !== itemId || got.item.runId !== runId) return "run_mismatch";
    const state = stateFor(record, surface);
    if (!state) return "not_pending";
    return enqueue(state, () => handle(state, event, precheck));
  }

  function noteRefusal(i: StageGateDecideInput): "note_required" | "note_too_long" | "note_invalid" | null {
    const note = i.note ?? "";
    if (i.decision === "request_changes" && note.trim().length === 0) return "note_required";
    if (note.length > MAX_PLAN_NOTE_LENGTH) return "note_too_long";
    return hasUnsafeDirectiveControlChars(note) ? "note_invalid" : null;
  }

  async function decideGate(itemId: number, i: StageGateDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageGateDecideResult> {
    const event: RunEvent = { type: "gate_decided", stageId: i.stageId, attempt: i.attempt, decision: i.decision, ...(i.note !== undefined && i.note.length > 0 ? { note: i.note } : {}) };
    const reason = await decide(itemId, i.runId, o.approvalSurface, event, (record) => {
      const state = runs.get(itemId);
      const run = record.stageRuns.find(candidate => candidate.stageId === i.stageId);
      if (!run) return "not_found";
      if (run.attempt !== i.attempt) return "attempt_mismatch";
      if (run.status !== "awaiting_gate" || run.gate?.type !== "human" || run.gate.status !== "pending" || !state || state.stopping || state.refused) return "not_pending";
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
      const state = runs.get(itemId);
      const join = record.stageJoins.find(candidate => candidate.joinId === i.joinId);
      if (!join) return "not_found";
      if (join.status !== "conflict" || !join.conflict || !state || state.stopping || state.refused) return "not_pending";
      return join.conflict.conflictHash === i.conflictHash ? null : "conflict_mismatch";
    });
    return reason === null ? { ok: true } : { ok: false, reason };
  }

  async function retryStage(itemId: number, i: { runId: string; stageId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult> {
    const reason = await decide(itemId, i.runId, o.approvalSurface, { type: "retry_requested", stageId: i.stageId }, (record) => {
      const state = runs.get(itemId);
      const run = record.stageRuns.find(candidate => candidate.stageId === i.stageId);
      if (!run) return "not_found";
      if (run.status !== "failed" || !state || state.stopping || state.refused) return "not_pending";
      return run.attempt >= MAX_STAGE_ATTEMPTS ? "attempts_exhausted" : null;
    });
    return reason === null ? { ok: true } : { ok: false, reason };
  }

  async function continueRun(itemId: number, i: { runId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult> {
    const reason = await decide(itemId, i.runId, o.approvalSurface, { type: "continue_requested" }, () => {
      const state = runs.get(itemId);
      if (!state || state.stopping || state.refused) return "not_pending";
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

  async function adoptParkedRuns(): Promise<void> {
    const active: string[] = [];
    for (const listed of await records.listUnsettled()) {
      const now = new Date().toISOString();
      const got = await store.get(listed.itemId);
      // A run no board row names any more can never be decided or stopped: it ends here.
      if (got.status !== "found" || got.item.runId !== listed.runId) {
        await records.update(listed.runId, current => ({ ...current, status: "error", updatedAt: now }));
        continue;
      }
      const parked = await reconcileRunRecord(listed, now, root => access(root).then(() => true, () => false));
      const record = parked ? (await records.update(listed.runId, () => parked)) ?? parked : listed;
      // Boot reconciliation of the board fails every row it finds running. This run is not lost: it waits for the user.
      if (got.item.runStatus !== "executing") await store.setRunStatus(listed.itemId, "executing");
      active.push(record.runId);
      stateFor(record, null);
    }
    await workspace.sweep(active).catch((error: unknown) => log.warn("stage workspace sweep failed: %s", errorMessage(error)));
  }

  return {
    start, decideGate, decideJoin, retryStage, continueRun, projectRootRevoked, steer, stop, adoptParkedRuns,
    liveStageSessions: itemId => new Map(runs.get(itemId)?.live ?? []),
    whenIdle: async (itemId) => { const state = runs.get(itemId); if (state) await idle(state); },
  };
}
