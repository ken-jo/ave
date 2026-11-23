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
type ChildWaitFailure = { error: Error; at: number; completed: boolean };
/** A failure that only the waits open at that moment take; nothing records it. */
type ChildWaitPulse = { error: Error; originSessionId?: string };
/** One origin's runs, on the harness clock: its latest accepted start, its latest end, the start of each call still pending, and its latest
 * failure. The failure stands while it is newer than the latest start and every pending call. The origin is in flight while its latest
 * start is newer than its latest end, or a call is pending. A call changes nothing until it resolves. */
type Flight = { startedAt: number; endedAt: number; pending: number[]; failure?: ChildWaitFailure };

function observeRunWork(launches: AsyncLocalStorage<ObservedLaunch>, onScheduled?: () => void) {
  const pending = new Set<Promise<unknown>>();
  const launchesPending = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>, queue = pending): void {
    queue.add(work);
    onScheduled?.();
    const remove = () => { queue.delete(work); };
    void work.then(remove, remove);
  }
  const observe: NonNullable<WorkflowDeps["_observeDetachedWorkForTest"]> = (work, kind) => {
    if (kind !== "launch") {
      track(work());
      return;
    }
    // A controlled child parks its launch after linkage and resumes tracking before it ends.
    const linked = deferred<void>();
    const done = launches.run({ linked: linked.resolve, resume: () => track(done, launchesPending) }, work);
    track(Promise.race([linked.promise, done]), launchesPending);
  };
  async function drain({ includeLaunches = true } = {}): Promise<void> {
    while (pending.size > 0 || (includeLaunches && launchesPending.size > 0)) {
      await Promise.allSettled(includeLaunches ? [...pending, ...launchesPending] : pending);
    }
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
  wiring?: (store: WorkBoardStore, harness: { workspace: StageWorkspaceProvider; templates: WorkflowTemplateStore }) => Partial<WorkflowDeps>;
  integrate?: () => IntegrateResult | Promise<IntegrateResult>;
  /** Replaces a part of the workspace provider. */
  workspace?: Partial<StageWorkspaceProvider>;
  /** Track detached work for each engine. */
  observeRunWork?: boolean;
  onRunWorkScheduled?: () => void;
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
  /** The project roots each boot sweep was given, by run id. */
  const sweptProjects: Map<string, string>[] = [];
  const registry = boardParentToolRegistry();
  const launches = new AsyncLocalStorage<ObservedLaunch>();
  const runWorkObservers: ReturnType<typeof observeRunWork>[] = [];
  /** `recheck` is set when a call closed refused: a failure it held off stands again, as if the wait were created now. */
  const childChanges = new Set<(pulse?: ChildWaitPulse, recheck?: boolean) => void>();
  /** Called with an error, a listener ends its wait with it. */
  const progressChanges = new Set<(ended?: Error) => void>();
  let closed = false;
  let lastRequestedOrigin: string | undefined;
  /** The harness clock: every start, call and failure takes the next tick, so "newer" is a plain comparison. */
  let seq = 0;
  /** The current engine's flights by origin; a replaced engine's calls keep writing to the map they started with, which nothing reads. */
  let flights = new Map<string, Flight>();
  function flightOf(origin: string, book = flights): Flight {
    const known = book.get(origin);
    if (known) return known;
    const flight: Flight = { startedAt: 0, endedAt: 0, pending: [] };
    book.set(origin, flight);
    return flight;
  }
  function standing(origin: string): ChildWaitFailure | undefined {
    const flight = flights.get(origin);
    const failure = flight?.failure;
    return flight && failure && failure.at > flight.startedAt && flight.pending.every(at => failure.at > at) ? failure : undefined;
  }
  const isInFlight = (flight: Flight) => flight.startedAt > flight.endedAt || flight.pending.length > 0;
  const inFlight = () => [...flights].filter(([, flight]) => isInFlight(flight)).map(([origin]) => origin);
  /** Where the origin's current flight began, or undefined while it is not in flight. */
  function flightStart(origin: string): number | undefined {
    const flight = flights.get(origin);
    if (!flight || !isInFlight(flight)) return undefined;
    return Math.min(...flight.pending, ...(flight.startedAt > flight.endedAt ? [flight.startedAt] : []));
  }
  const notify = (pulse?: ChildWaitPulse, recheck = false) => { for (const changed of childChanges) changed(pulse, recheck); };
  const pulse = (reason: string, originSessionId?: string) => notify({ error: new Error(`Child wait ended: ${reason}`), originSessionId });
  function fail(reason: string, origin: string, completed = false): void {
    flightOf(origin).failure = { error: new Error(`Child wait ended: ${reason}`), at: ++seq, completed };
  }
  function endRun(reason: string, origin: string, completed = false): void {
    fail(reason, origin, completed);
    flightOf(origin).endedAt = seq;
    notify();
  }
  /** Opens a call for the origin on the current engine; the returned function closes it, and only an accepted call starts the origin. */
  function openCall(origin: string): (accepted: boolean) => void {
    const book = flights;
    const at = ++seq;
    const flight = flightOf(origin, book);
    flight.pending.push(at);
    return accepted => {
      flight.pending.splice(flight.pending.indexOf(at), 1);
      if (accepted) flight.startedAt = Math.max(flight.startedAt, at);
      if (book === flights) notify(undefined, !accepted);
    };
  }

  /** Children a replaced engine spawned after its replacement. Waits never count them, while `children` and `live()` keep every child, so
   * once a stray exists a count taken from `children.length` runs ahead of what a wait counts. */
  const strays = new WeakSet<FakeChild>();
  let generation = 0;
  const ofCurrentEngine = (list: FakeChild[]) => list.filter(child => !strays.has(child));
  async function spawnChild(by: number, input: SubAgentSpawnInput, hooks?: { onLinked?: (link: { childSessionId: string }) => void }): Promise<SubAgentSpawnResult> {
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
        if (liveChildren.delete(child)) notify();
      },
    };
    children.push(child);
    if (by !== generation) strays.add(child);
    try {
      hooks?.onLinked?.({ childSessionId: sessionId });
      const scripted = opts.script?.(input);
      if (scripted) child.finish(scripted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      child.finish({ ok: false, error: message });
      if (by === generation) pulse(message, input.originSessionId);
      throw error;
    }
    if (!child.ended) {
      liveChildren.add(child);
      launch?.linked();
    }
    notify();
    return done;
  }
  const runner = {
    spawn: (input: SubAgentSpawnInput, hooks?: { onLinked?: (link: { childSessionId: string }) => void }) => spawnChild(generation, input, hooks),
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
    discard: async () => [],
    sweep: async (active, projects) => { sweeps.push([...active]); sweptProjects.push(new Map(projects)); },
    ...opts.workspace,
  };

  function engineOn(store: WorkBoardStore): ReturnType<typeof createWorkBoardEngine> {
    const runWork = opts.observeRunWork ? observeRunWork(launches, opts.onRunWorkScheduled) : undefined;
    if (runWork) runWorkObservers.push(runWork);
    const workflow = {
      templates, attachments: templates, runs: boardRunState(store), workspace, authoriseRunSource, passConditions: createPassConditionRegistry(),
      scopeAuthorised: (scope: TemplateScope) => scope.kind === "all" || !unauthorised.has(scope.projectRoot),
      resolveProjectRoot: (root: string) => unauthorised.has(root) ? null : root,
      audit: (event: (typeof audits)[number]) => { audits.push(event); },
      ...opts.workflow,
      ...opts.wiring?.(store, { workspace, templates }),
      ...(runWork ? { _observeDetachedWorkForTest: runWork.observe } : {}),
    } satisfies WorkflowDeps;
    // A replaced engine's later events never show that this engine's child registered.
    const own: WorkBoardRunEvent[] = [];
    const by = generation;
    // Only this engine's spawns, while it is current, start an origin.
    const engineRunner = Object.assign(Object.create(runner) as SubAgentRunner, {
      spawn: (...args: Parameters<SubAgentRunner["spawn"]>) => {
        const origin = args[0].originSessionId;
        if (engine === wrapped && origin !== undefined) {
          flightOf(origin).startedAt = ++seq;
        }
        return spawnChild(by, ...args);
      },
    });
    const current = createWorkBoardEngine({
      store,
      getRunner: () => engineRunner,
      emitProgress: event => {
        const { itemId, phase, stageId, attempt } = event;
        if (engine === wrapped) {
          if (phase === "stage_failed") {
            const prior = own.findLast(candidate => candidate.itemId === itemId && candidate.phase === "executing"
              && (candidate.stageId === undefined ? candidate.message === undefined : candidate.stageId === stageId && candidate.attempt === attempt));
            if (!prior?.runSessionId) {
              fail(`${phase}: ${event.message ?? "child did not register"}`, workBoardOriginSessionId(itemId));
              notify();
            }
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
    /** A user call on an item's run: it starts the item only if the engine accepts it. */
    function accepted<T extends { ok: boolean }>(itemId: number, call: () => Promise<T>): Promise<T> {
      if (engine !== wrapped) return call();
      const close = openCall(workBoardOriginSessionId(itemId));
      return call().then(result => { close(result.ok); return result; }, (error: unknown) => { close(false); throw error; });
    }
    const wrapped = {
      ...current,
      async runItem(...args: Parameters<typeof current.runItem>) {
        if (engine !== wrapped) return current.runItem(...args);
        const [itemId] = args;
        const origin = workBoardOriginSessionId(itemId);
        lastRequestedOrigin = origin;
        const close = openCall(origin);
        const first = children.length;
        const spawned = () => ofCurrentEngine(children.slice(first)).some(child => child.input.originSessionId === origin);
        let result: Awaited<ReturnType<typeof current.runItem>>;
        try {
          result = await current.runItem(...args);
        } catch (error) {
          close(true);
          if (engine === wrapped) endRun(String(error), origin);
          throw error;
        }
        // A second start leaves the run in progress, and its failure, as they were.
        close(result.status !== "already_running");
        if (engine !== wrapped || result.status === "already_running") return result;
        if (result.status !== "awaiting_approval") endRun(`${result.status}: ${"reason" in result ? result.reason : "run ended"}`, origin, result.status === "completed");
        else if (!spawned()) pulse("awaiting_approval: run ended without the requested child", origin);
        return result;
      },
      retryStage(...args: Parameters<typeof current.retryStage>) {
        return accepted(args[0], () => current.retryStage(...args));
      },
      decideStageGate(...args: Parameters<typeof current.decideStageGate>) {
        return accepted(args[0], () => current.decideStageGate(...args));
      },
      decideStageJoin(...args: Parameters<typeof current.decideStageJoin>) {
        return accepted(args[0], () => current.decideStageJoin(...args));
      },
      continueRun(...args: Parameters<typeof current.continueRun>) {
        return accepted(args[0], () => current.continueRun(...args));
      },
      cancelRun(itemId: number) {
        const result = current.cancelRun(itemId);
        // An accepted Stop ends the run for waits even while the run's class holds its end.
        if (result.ok && engine === wrapped) endRun("run cancelled", workBoardOriginSessionId(itemId));
        return result;
      },
    };
    return wrapped;
  }
  let engine = engineOn(board);
  /** The next process over the same files: a new board store and a new engine. The first engine is left as a crash leaves it. */
  const makeEngine = () => {
    pulse("engine replaced");
    lastRequestedOrigin = undefined;
    flights = new Map();
    generation += 1;
    board = new WorkBoardStore(boardPath);
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
  /** The one bound on a signal wait: below the test timeout, so a stuck wait names what it was waiting on; a slow preparation stays
   * inside it. It never keeps the process alive by itself. Returns what clears it. */
  function boundWait(expire: () => void): () => void {
    const timeout = setTimeout(expire, 30_000);
    timeout.unref();
    return () => clearTimeout(timeout);
  }
  /** Resolves on the signal that makes `get` defined; rejects with `failure` once the bound expires, or with the error it is signalled. */
  function waitForSignal<T>(listeners: Set<(ended?: Error) => void>, get: () => T | undefined, failure: string): Promise<T> {
    const current = get();
    if (current !== undefined) return Promise.resolve(current);
    return new Promise<T>((resolve, reject) => {
      const clear = boundWait(() => {
        listeners.delete(changed);
        reject(new Error(failure));
      });
      function changed(ended?: Error) {
        if (ended) {
          listeners.delete(changed);
          clear();
          reject(ended);
          return;
        }
        const value = get();
        if (value === undefined) return;
        listeners.delete(changed);
        clear();
        resolve(value);
      }
      listeners.add(changed);
    });
  }
  /** A wait for one item takes that item's standing failure. An aggregate wait (no `itemId`) is created failed only when every item in flight
   * (or else the last one started) has a standing failure; while it waits it takes a failure of an item in its scope (every item in flight,
   * and for a live count each item whose live child it counted) that is newer than the wait and than that item's flight. A spawn count
   * ignores the normal completion of an item it counted a child of while another item without a standing failure is in flight. */
  function waitForChildren(get: () => FakeChild[], done: (list: FakeChild[]) => boolean, countsLive: boolean, itemId?: number): Promise<FakeChild[]> {
    if (closed) return Promise.reject(new Error("Child wait ended: harness cleaned up"));
    const current = get();
    if (done(current)) return Promise.resolve(current);
    const origin = itemId === undefined ? undefined : workBoardOriginSessionId(itemId);
    const createdAt = seq;
    /** Each origin in the scope, with the tick after which its failures count. */
    const scope = new Map<string, number>();
    const widen = (list: FakeChild[]) => {
      if (origin !== undefined) return;
      const from = [...inFlight(), ...(countsLive ? list.filter(child => !child.ended).map(child => child.input.originSessionId ?? "") : [])];
      for (const candidate of from) if (candidate !== "" && !scope.has(candidate)) scope.set(candidate, Math.max(createdAt, flightStart(candidate) ?? seq));
    };
    function failed(value: FakeChild[]): Error | undefined {
      if (origin !== undefined) return standing(origin)?.error;
      let newest: ChildWaitFailure | undefined;
      const counted = scope.size > 0 ? [...scope] : [...flights.keys()].map(from => [from, createdAt] as const);
      for (const [from, since] of counted) {
        const failure = standing(from);
        if (!failure || failure.at <= since) continue;
        if (!countsLive && failure.completed && value.some(child => child.input.originSessionId === from)
          && inFlight().some(other => other !== from && !standing(other))) continue;
        if (!newest || failure.at > newest.at) newest = failure;
      }
      return newest?.error;
    }
    /** The creation rule: the item's standing failure, or for an aggregate wait one only when every candidate has a standing failure. */
    function createdFailed(): Error | undefined {
      if (origin !== undefined) return standing(origin)?.error;
      const flying = inFlight();
      const candidates = flying.length > 0 ? flying : lastRequestedOrigin !== undefined ? [lastRequestedOrigin] : [];
      const failures = candidates.map(standing).filter(failure => failure !== undefined);
      if (failures.length === 0 || failures.length < candidates.length) return undefined;
      // The newest failure names it, whatever order the items were first seen in.
      return failures.reduce((newest, failure) => failure.at > newest.at ? failure : newest).error;
    }
    widen(current);
    const failedAtCreation = createdFailed();
    if (failedAtCreation) return Promise.reject(failedAtCreation);
    return new Promise((resolve, reject) => {
      const clear = boundWait(() => {
        childChanges.delete(changed);
        reject(new Error(`timed out waiting for children; in flight: ${inFlight().join(", ") || "none"}`));
      });
      function settle(): void {
        childChanges.delete(changed);
        clear();
      }
      function changed(pulse?: ChildWaitPulse, recheck = false) {
        const value = get();
        widen(value);
        if (done(value)) {
          settle();
          resolve(value);
          return;
        }
        const from = pulse?.originSessionId;
        const error = pulse && (from === undefined || (origin !== undefined ? from === origin : scope.size === 0 || scope.has(from)))
          ? pulse.error : failed(value) ?? (recheck ? createdFailed() : undefined);
        if (!error) return;
        settle();
        reject(error);
      }
      childChanges.add(changed);
    });
  }
  const forItem = (list: FakeChild[], itemId?: number) =>
    itemId === undefined ? list : list.filter(child => child.input.originSessionId === workBoardOriginSessionId(itemId));
  const untilLive = (count: number, itemId?: number) => waitForChildren(() => forItem(ofCurrentEngine(live()), itemId), active => active.length === count, true, itemId);
  const waitForLive = untilLive;
  const untilSpawned = (count: number, itemId?: number) => waitForChildren(() => forItem(ofCurrentEngine(children), itemId), spawned => spawned.length >= count, false, itemId);
  const progressEnded = () => new Error("Progress wait ended: harness cleaned up");
  /** `what`: the event the wait names when its bound expires. */
  const waitForProgress = (check: (event: WorkBoardRunEvent) => boolean, what: string) => closed
    ? Promise.reject(progressEnded())
    : waitForSignal(progressChanges, () => events.find(check), `progress signal never arrived for ${what}`);
  /** The event that ended the run; it follows the stored status, so a test waits for it. */
  const settleEvent = () => waitForProgress(event => event.phase === "cancelled" || event.phase === "done" || event.phase === "denied" || event.phase === "error",
    "a run's end (cancelled, done, denied or error)");
  /** The decision the board would send for the stored gate of the stage. */
  async function decide(itemId: number, stageId: string, decision: "approve" | "reject" | "request_changes", note?: string) {
    const current = await item(itemId);
    const run = await stageRun(itemId, stageId);
    return engine.decideStageGate(itemId, { runId: current.runId ?? "", stageId, attempt: run.attempt, resultHash: run.resultHash ?? "", decision, ...(note !== undefined ? { note } : {}) });
  }
  const start = (itemId: number, source: RunAuthoritySource) => engine.runItem(itemId, { templateSource: source });

  return {
    dir, boardPath, get board() { return board; }, templates, get engine() { return engine; }, makeEngine, editRow, runOf, events, children, interrupts, audits, unauthorised, workspaceCalls, sweeps, sweptProjects,
    confirm: confirmTemplate, pinOf, addItem, local, attach, detach, item, stageRun, until, untilStage, untilLive, untilSpawned, settleEvent, waitForLive, waitForProgress, live, decide, statusOf, start,
    drainRunWork: async (options?: { includeLaunches?: boolean }) => { await runWorkObservers.at(-1)?.drain(options); },
    drainAllRunWork: async () => { await Promise.all(runWorkObservers.map(runWork => runWork.drain())); },
    /** Listeners of the child and progress waits still pending. */
    pendingWaits: () => childChanges.size + progressChanges.size,
    cleanup: () => {
      closed = true;
      pulse("harness cleaned up");
      const ended = progressEnded();
      for (const changed of progressChanges) changed(ended);
      return cleanupTmpDir(dir);
    },
  };
}
