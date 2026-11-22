import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunAuthoritySource, StageJoin, TemplateScope, TemplateStage, TemplateVersion, TemplateVersionPin, WorkItemStageRun,
} from "../../../shared/workflow-template-types.js";
import { type WorkBoardRunEvent, type WorkItemResolved, workBoardOriginSessionId } from "../../../shared/work-board-types.js";
import type { SubAgentRunner, SubAgentSpawnInput, SubAgentSpawnResult } from "../../../engine/subagent-runner.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
import { WorkflowTemplateStore } from "../../../main/workflow-template-store.js";
import { mintHostDecisionProof } from "../../../main/workflow-template-decision.js";
import { createWorkBoardEngine, type WorkBoardEngineDeps } from "../../../core/work-board-engine.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { boardParentToolRegistry } from "../../__tests__/board-test-fixtures.js";
import { authoriseRunSource } from "../run-authority.js";
import { boardRunState, type RunRecord } from "../run-state.js";
import { createPassConditionRegistry } from "../stage-gates.js";
import type { StageWorkspaceProvider } from "../stage-workspace.js";
import type { JoinConflict } from "../shipped-shapes.js";

export interface FakeChild {
  input: SubAgentSpawnInput;
  sessionId: string;
  ended: boolean;
  steers: string[];
  finish(result?: Partial<SubAgentSpawnResult>): void;
}

type IntegrateResult = { ok: true } | { ok: false; conflict: JoinConflict };

/** What a test looks at: the board row, with the stage runs and joins of the run the row names taken from the run file. */
export type StageRunView = WorkItemResolved & { stageRuns: WorkItemStageRun[]; stageJoins: StageJoin[]; record: RunRecord | null };
type WorkflowDeps = NonNullable<WorkBoardEngineDeps["workflow"]>;
type ObservedLaunch = { linked(): void; resume(): void };
type ChildWaitFailure = { error: Error; originSessionId?: string; completed?: boolean };

function observeRunWork(launches: AsyncLocalStorage<ObservedLaunch>) {
  const pending = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    pending.add(work);
    const remove = () => { pending.delete(work); };
    void work.then(remove, remove);
  }
  const observe: NonNullable<WorkflowDeps["_observeDetachedWorkForTest"]> = (work, kind) => {
    if (kind !== "launch") {
      track(work());
      return;
    }
    // A controlled child parks its launch after linkage and resumes tracking before it ends.
    const linked = deferred<void>();
    const done = launches.run({ linked: linked.resolve, resume: () => track(done) }, work);
    track(Promise.race([linked.promise, done]));
  };
  async function drain(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled(pending);
  }
  return { observe, drain };
}

/** A real board, run file and template store in a temp folder, a runner whose children end when the test says so, and a workspace provider that
 * hands every stage its own folder name under the run root. */
export async function stageRunHarness(opts: {
  /** Returns a result to end the child at once; undefined leaves it live until the test finishes it. */
  script?: (input: SubAgentSpawnInput) => Partial<SubAgentSpawnResult> | undefined;
  workflow?: Partial<WorkflowDeps>;
  /** Parts chosen for the board store the engine runs on (the production wiring is chosen this way); they replace the harness's own. */
  wiring?: (store: WorkBoardStore, harness: { workspace: StageWorkspaceProvider }) => Partial<WorkflowDeps>;
  integrate?: () => IntegrateResult | Promise<IntegrateResult>;
  /** Replaces a part of the workspace provider. */
  workspace?: Partial<StageWorkspaceProvider>;
  /** Track detached work for the current engine. */
  observeRunWork?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ave-stage-run-"));
  const boardPath = join(dir, "board.json");
  let board = new WorkBoardStore(boardPath);
  const templates = new WorkflowTemplateStore(join(dir, "templates.json"));
  const events: WorkBoardRunEvent[] = [];
  const children: FakeChild[] = [];
  const liveChildren = new Set<FakeChild>();
  const interrupts: string[] = [];
  const audits: Parameters<NonNullable<WorkflowDeps["audit"]>>[0][] = [];
  const unauthorised = new Set<string>();
  const workspaceCalls: string[] = [];
  /** The run ids each boot sweep kept. */
  const sweeps: string[][] = [];
  const registry = boardParentToolRegistry();
  const launches = new AsyncLocalStorage<ObservedLaunch>();
  const observeEngineWork = () => opts.observeRunWork ? observeRunWork(launches) : undefined;
  let runWork = observeEngineWork();
  const childChanges = new Set<(failure?: ChildWaitFailure) => void>();
  const progressChanges = new Set<() => void>();
  let closed = false;
  let lastRequestedOrigin: string | undefined;
  /** The last terminal run event of each origin since its latest start, for waits created after it. */
  const failures = new Map<string, Error>();
  /** Origins whose run was started or spawned a child and has not ended. */
  const inFlight = new Set<string>();

  function failChildWaits(reason: string, originSessionId?: string, terminal = false, completed = false): void {
    const error = new Error(`Child wait ended: ${reason}`);
    if (terminal && originSessionId !== undefined) failures.set(originSessionId, error);
    for (const changed of childChanges) changed({ error, originSessionId, completed });
  }
  function endRun(reason: string, originSessionId: string, completed = false): void {
    failChildWaits(reason, originSessionId, true, completed);
    inFlight.delete(originSessionId);
  }

  const runner = {
    async spawn(input: SubAgentSpawnInput, hooks?: { onLinked?: (link: { childSessionId: string }) => void }): Promise<SubAgentSpawnResult> {
      await Promise.resolve();
      const sessionId = `child-${children.length + 1}`;
      const launch = launches.getStore();
      let end: (result: SubAgentSpawnResult) => void = () => undefined;
      const done = new Promise<SubAgentSpawnResult>(resolve => { end = resolve; });
      const child: FakeChild = {
        input, sessionId, ended: false, steers: [],
        finish: (result = {}) => {
          if (child.ended) return;
          child.ended = true;
          launch?.resume();
          end({ summary: `output of ${sessionId}`, toolCallCount: 0, turnCount: 1, childSessionId: sessionId, entries: [], ok: true, endTrustOrigin: "llm-tool-arg", ...result });
          if (liveChildren.delete(child)) for (const changed of childChanges) changed();
        },
      };
      children.push(child);
      if (input.originSessionId !== undefined) {
        failures.delete(input.originSessionId);
        inFlight.add(input.originSessionId);
      }
      try {
        hooks?.onLinked?.({ childSessionId: sessionId });
        const scripted = opts.script?.(input);
        if (scripted) child.finish(scripted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        child.finish({ ok: false, error: message });
        failChildWaits(message, input.originSessionId);
        throw error;
      }
      if (!child.ended) {
        liveChildren.add(child);
        launch?.linked();
      }
      for (const changed of childChanges) changed();
      return done;
    },
    interruptRun(id: string) {
      interrupts.push(id);
      const child = children.find(candidate => candidate.sessionId === id && !candidate.ended);
      child?.finish({ ok: false, summary: "interrupted", error: "interrupted", stopReason: "interrupted" });
      return { ok: child !== undefined, message: "" };
    },
    queueHostDirectiveToWorkBoardChild(_origin: string, id: string, text: string) {
      const child = children.find(candidate => candidate.sessionId === id && !candidate.ended);
      if (!child) return { ok: false, reason: "not-executing" };
      child.steers.push(text);
      return { ok: true, messageId: `m-${child.steers.length}` };
    },
    parentToolRegistry: () => registry,
  } as unknown as SubAgentRunner;

  const workspace: StageWorkspaceProvider = {
    open: async (run, projectRoot) => {
      workspaceCalls.push(`open:${projectRoot ?? ""}`);
      return { ok: true, workspace: { kind: "folder", runRoot: join(dir, "runs", run.runId) } };
    },
    prepare: async (run, stage, attempt) => {
      workspaceCalls.push(`prepare:${stage.id}#${attempt}`);
      const root = join(dir, "runs", run.runId, `${stage.id}-${attempt}`);
      mkdirSync(root, { recursive: true });
      return { ok: true, workspace: { kind: "folder", root } };
    },
    seal: async (_run, stageId) => { workspaceCalls.push(`seal:${stageId}`); return { ok: true }; },
    integrate: async (_run, joinId) => { workspaceCalls.push(`integrate:${joinId}`); return opts.integrate?.() ?? { ok: true }; },
    release: async () => undefined,
    sweep: async (active) => { sweeps.push([...active]); },
    ...opts.workspace,
  };

  function engineOn(store: WorkBoardStore): ReturnType<typeof createWorkBoardEngine> {
    const workflow = {
      templates, attachments: templates, runs: boardRunState(store), workspace, authoriseRunSource, passConditions: createPassConditionRegistry(),
      scopeAuthorised: (scope: TemplateScope) => scope.kind === "all" || !unauthorised.has(scope.projectRoot),
      resolveProjectRoot: (root: string) => unauthorised.has(root) ? null : root,
      audit: (event: (typeof audits)[number]) => { audits.push(event); },
      ...opts.workflow,
      ...opts.wiring?.(store, { workspace }),
      ...(runWork ? { _observeDetachedWorkForTest: runWork.observe } : {}),
    } satisfies WorkflowDeps;
    // A replaced engine's later events never show that this engine's child registered.
    const own: WorkBoardRunEvent[] = [];
    const current = createWorkBoardEngine({
      store,
      getRunner: () => runner,
      emitProgress: event => {
        const { itemId, phase, stageId, attempt } = event;
        if (engine === wrapped) {
          if (phase === "stage_failed") {
            const prior = own.findLast(candidate => candidate.itemId === itemId && candidate.phase === "executing"
              && (candidate.stageId === undefined ? candidate.message === undefined : candidate.stageId === stageId && candidate.attempt === attempt));
            if (!prior?.runSessionId) failChildWaits(`${phase}: ${event.message ?? "child did not register"}`, workBoardOriginSessionId(itemId), true);
          } else if (event.message !== "restored" && event.reasonCode !== "run-end-confirmed"
            && (phase === "done" || phase === "denied" || phase === "cancelled" || phase === "error")) {
            endRun(`${phase}: ${event.reasonCode ?? event.message ?? "run ended"}`, workBoardOriginSessionId(itemId), phase === "done");
          }
        }
        events.push(event);
        own.push(event);
        for (const changed of progressChanges) changed();
      },
      workflow,
    });
    /** An accepted retry or decision clears the failure it superseded, unless a newer one arrived while it ran. */
    function restarted<T extends { ok: boolean }>(itemId: number, result: T, before: Error | undefined): T {
      const origin = workBoardOriginSessionId(itemId);
      if (result.ok && engine === wrapped && failures.get(origin) === before) failures.delete(origin);
      return result;
    }
    const wrapped = {
      ...current,
      async runItem(...args: Parameters<typeof current.runItem>) {
        const [itemId] = args;
        const origin = workBoardOriginSessionId(itemId);
        if (engine === wrapped) {
          lastRequestedOrigin = origin;
          failures.delete(origin);
          inFlight.add(origin);
        }
        const first = children.length;
        const spawned = () => children.slice(first).some(child => child.input.originSessionId === origin);
        try {
          const result = await current.runItem(...args);
          // The run already in progress is unaffected by a second start.
          if (result.status === "already_running") return result;
          if (engine === wrapped && result.status !== "awaiting_approval") endRun(`${result.status}: ${"reason" in result ? result.reason : "run ended"}`, origin, result.status === "completed");
          else if (engine === wrapped && !spawned()) failChildWaits("awaiting_approval: run ended without the requested child", origin);
          return result;
        } catch (error) {
          if (engine === wrapped) endRun(String(error), origin);
          throw error;
        }
      },
      async retryStage(...args: Parameters<typeof current.retryStage>) {
        const before = failures.get(workBoardOriginSessionId(args[0]));
        return restarted(args[0], await current.retryStage(...args), before);
      },
      async decideStageGate(...args: Parameters<typeof current.decideStageGate>) {
        const before = failures.get(workBoardOriginSessionId(args[0]));
        return restarted(args[0], await current.decideStageGate(...args), before);
      },
      cancelRun(itemId: number) {
        const result = current.cancelRun(itemId);
        // An accepted Stop ends the run for waits even while the run's class holds its end.
        if (result.ok && engine === wrapped) {
          failChildWaits("run cancelled", workBoardOriginSessionId(itemId));
          inFlight.delete(workBoardOriginSessionId(itemId));
        }
        return result;
      },
    };
    return wrapped;
  }
  let engine = engineOn(board);
  /** The next process over the same files: a new board store and a new engine. The first engine is left as a crash leaves it. */
  const makeEngine = () => {
    failChildWaits("engine replaced");
    lastRequestedOrigin = undefined;
    failures.clear();
    inFlight.clear();
    board = new WorkBoardStore(boardPath);
    runWork = observeEngineWork();
    engine = engineOn(board);
    return engine;
  };
  /** Hand-edit a row of the board file, as nothing in the app would. A loaded store keeps its copy: the next `makeEngine` reads it. */
  function editRow(itemId: number, edit: (row: Record<string, unknown>) => Record<string, unknown>): void {
    const file = JSON.parse(readFileSync(boardPath, "utf8")) as { items: Record<string, unknown>[] };
    file.items = file.items.map(row => row.id === itemId ? edit(row) : row);
    writeFileSync(boardPath, JSON.stringify(file));
  }

  const actor = { who: "alice", origin: "local-desktop" } as const;
  /** Confirm a new template, or the next version of `id`. Edges follow the inputs of each stage. */
  async function confirmTemplate(stages: TemplateStage[], over: { id?: string; scope?: TemplateScope; setupCommands?: string[] } = {}): Promise<TemplateVersion> {
    const edges = stages.flatMap(stage => stage.inputs.map(from => ({ from, to: stage.id })));
    const record = await templates.draft(over.id ?? null, { name: "Template", scope: over.scope ?? { kind: "all" }, stages, edges, ...(over.setupCommands ? { setupCommands: over.setupCommands } : {}) });
    if (!record.draft) throw new Error("no draft");
    return templates.confirmDraft(record.template.id, { expectedGraphHash: record.draft.graphHash, expectedDraftRevision: record.draft.revision }, actor);
  }
  const pinOf = (version: TemplateVersion): TemplateVersionPin => ({ templateId: version.templateId, version: version.version, graphHash: version.graphHash });
  async function addItem(version: TemplateVersion, projectRoot?: string): Promise<number> {
    const created = await board.create({ title: "Work", templateId: version.templateId, ...(projectRoot ? { projectRoot } : {}) });
    if (created.status !== "created") throw new Error("item not created");
    return created.itemId;
  }
  const local = (version: TemplateVersion, projectRoot?: string): RunAuthoritySource =>
    ({ kind: "local-create-and-run", pin: pinOf(version), ...(projectRoot ? { projectRoot } : {}) });
  async function attach(version: TemplateVersion, approvedScope: TemplateScope = { kind: "all" }): Promise<{ id: string; source: RunAuthoritySource }> {
    const attachment = await templates.attachSchedule({ scheduleId: "daily", ...pinOf(version) }, mintHostDecisionProof("local-desktop"), approvedScope);
    return { id: attachment.id, source: { kind: "schedule-attachment", attachmentId: attachment.id, pin: pinOf(version), firedAt: "2026-11-16T00:00:00.000Z" } };
  }
  const detach = (id: string): Promise<boolean> => templates.detachSchedule(id, mintHostDecisionProof("local-desktop"));
  /** The stored run, read by its id from the run file whether or not a row still names it. */
  async function runOf(runId: string): Promise<RunRecord | null> {
    const read = await board.runs.get(runId);
    return read.status === "found" ? read.run : null;
  }
  async function item(itemId: number): Promise<StageRunView> {
    const got = await board.get(itemId);
    if (got.status !== "found") throw new Error("item not found");
    const record = got.item.runId === undefined ? null : await runOf(got.item.runId);
    return { ...got.item, stageRuns: record?.stageRuns ?? [], stageJoins: record?.stageJoins ?? [], record };
  }
  async function stageRun(itemId: number, stageId: string): Promise<WorkItemStageRun> {
    const run = (await item(itemId)).stageRuns.find(candidate => candidate.stageId === stageId);
    if (!run) throw new Error(`no stage run ${stageId}`);
    return run;
  }
  /** Poll until the stored item satisfies `check`; the engine works through its own queue, so a test never sleeps a fixed time. */
  async function until(itemId: number, check: (item: StageRunView) => boolean): Promise<StageRunView> {
    for (let i = 0; i < 400; i += 1) {
      const current = await item(itemId);
      if (check(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`timed out: ${JSON.stringify((await item(itemId)).stageRuns)}`);
  }
  const statusOf = (current: StageRunView, stageId: string) => current.stageRuns.find(run => run.stageId === stageId)?.status;
  const untilStage = (itemId: number, stageId: string, status: WorkItemStageRun["status"]) => until(itemId, current => statusOf(current, stageId) === status);
  const live = () => [...liveChildren];
  function waitForSignal<T>(listeners: Set<() => void>, get: () => T | undefined, description?: string): Promise<T> {
    const current = get();
    if (current !== undefined) return Promise.resolve(current);
    return new Promise<T>((resolve, reject) => {
      const timeout = description === undefined ? undefined : setTimeout(() => {
        listeners.delete(changed);
        reject(new Error(`timed out waiting for ${description}`));
      }, 2_000);
      function changed() {
        const value = get();
        if (value === undefined) return;
        listeners.delete(changed);
        clearTimeout(timeout);
        resolve(value);
      }
      listeners.add(changed);
    });
  }
  /** An aggregate wait (no `itemId`) takes failures of every item in flight while it waits, and is created failed only when each of them
   * has failed. A live count also takes failures of items whose live child it counted; a spawn count ignores the normal completion of an
   * item it has already counted a child of while another item without a failure is still in flight. */
  function waitForChildren(get: () => FakeChild[], done: (list: FakeChild[]) => boolean, countsLive: boolean, itemId?: number): Promise<FakeChild[]> {
    if (closed) return Promise.reject(new Error("Child wait ended: harness cleaned up"));
    const current = get();
    if (done(current)) return Promise.resolve(current);
    const origin = itemId === undefined ? undefined : workBoardOriginSessionId(itemId);
    const scope = new Set<string>();
    const widen = (list: FakeChild[]) => {
      if (origin !== undefined) return;
      for (const from of inFlight) scope.add(from);
      if (countsLive) for (const child of list) if (!child.ended && child.input.originSessionId) scope.add(child.input.originSessionId);
    };
    widen(current);
    const candidates = origin !== undefined ? [origin] : inFlight.size > 0 ? [...inFlight] : lastRequestedOrigin !== undefined ? [lastRequestedOrigin] : [];
    if (candidates.length > 0 && candidates.every(from => failures.has(from))) return Promise.reject(failures.get(candidates.at(-1) ?? ""));
    return new Promise((resolve, reject) => {
      function changed(failure?: ChildWaitFailure) {
        const value = get();
        widen(value);
        if (done(value)) {
          childChanges.delete(changed);
          resolve(value);
          return;
        }
        if (!failure) return;
        const from = failure.originSessionId;
        if (from !== undefined && origin !== undefined && from !== origin) return;
        if (from !== undefined && origin === undefined && scope.size > 0
          && (!scope.has(from) || (!countsLive && failure.completed && value.some(child => child.input.originSessionId === from)
            && [...inFlight].some(other => other !== from && !failures.has(other))))) return;
        childChanges.delete(changed);
        reject(failure.error);
      }
      childChanges.add(changed);
    });
  }
  const forItem = (list: FakeChild[], itemId?: number) =>
    itemId === undefined ? list : list.filter(child => child.input.originSessionId === workBoardOriginSessionId(itemId));
  const untilLive = (count: number, itemId?: number) => waitForChildren(() => forItem(live(), itemId), active => active.length === count, true, itemId);
  const waitForLive = untilLive;
  const untilSpawned = (count: number, itemId?: number) => waitForChildren(() => forItem(children, itemId), spawned => spawned.length >= count, false, itemId);
  const waitForProgress = (check: (event: WorkBoardRunEvent) => boolean) => waitForSignal(progressChanges, () => events.find(check), "run progress");
  /** The event that ended the run; it follows the stored status, so a test waits for it. */
  const settleEvent = () => waitForProgress(event => event.phase === "cancelled" || event.phase === "done" || event.phase === "denied" || event.phase === "error");
  /** The decision the board would send for the stored gate of the stage. */
  async function decide(itemId: number, stageId: string, decision: "approve" | "reject" | "request_changes", note?: string) {
    const current = await item(itemId);
    const run = await stageRun(itemId, stageId);
    return engine.decideStageGate(itemId, { runId: current.runId ?? "", stageId, attempt: run.attempt, resultHash: run.resultHash ?? "", decision, ...(note !== undefined ? { note } : {}) });
  }
  const start = (itemId: number, source: RunAuthoritySource) => engine.runItem(itemId, { templateSource: source });

  return {
    dir, boardPath, get board() { return board; }, templates, get engine() { return engine; }, makeEngine, editRow, runOf, events, children, interrupts, audits, unauthorised, workspaceCalls, sweeps,
    confirm: confirmTemplate, pinOf, addItem, local, attach, detach, item, stageRun, until, untilStage, untilLive, untilSpawned, settleEvent, waitForLive, waitForProgress, live, decide, statusOf, start,
    drainRunWork: async () => { await runWork?.drain(); },
    cleanup: () => {
      closed = true;
      failChildWaits("harness cleaned up");
      return cleanupTmpDir(dir);
    },
  };
}
