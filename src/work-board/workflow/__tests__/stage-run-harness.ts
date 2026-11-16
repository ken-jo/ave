import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunAuthoritySource, StageJoin, TemplateScope, TemplateStage, TemplateVersion, TemplateVersionPin, WorkItemStageRun,
} from "../../../shared/workflow-template-types.js";
import type { WorkBoardRunEvent, WorkItem } from "../../../shared/work-board-types.js";
import type { SubAgentRunner, SubAgentSpawnInput, SubAgentSpawnResult } from "../../../engine/subagent-runner.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
import { WorkflowTemplateStore } from "../../../main/workflow-template-store.js";
import { mintHostDecisionProof } from "../../../main/workflow-template-decision.js";
import { createWorkBoardEngine, type WorkBoardEngineDeps } from "../../../core/work-board-engine.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { boardParentToolRegistry } from "../../__tests__/board-test-fixtures.js";
import { authoriseRunSource } from "../run-authority.js";
import type { RunRecord, WorkflowRunState } from "../run-state.js";
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

/** Run state held in memory, cloned on every read and write as a file would be. It outlives an engine, so a second engine reads what the
 * first one wrote. */
function memoryRunState(): WorkflowRunState & { all(): RunRecord[] } {
  const stored = new Map<string, RunRecord>();
  return {
    begin: async (run) => {
      if (stored.has(run.runId)) throw new Error("run id already known");
      stored.set(run.runId, structuredClone(run));
    },
    get: async (runId) => structuredClone(stored.get(runId) ?? null),
    update: async (runId, mutate) => {
      const current = stored.get(runId);
      if (!current) return null;
      const next = structuredClone(mutate(structuredClone(current)));
      stored.set(runId, next);
      return structuredClone(next);
    },
    listUnsettled: async () => structuredClone([...stored.values()].filter(run => run.status === "executing")),
    all: () => structuredClone([...stored.values()]),
  };
}

/** What a test looks at: the board row, with the stage runs and joins of the run the row names taken from the run state. */
export type StageRunView = Omit<WorkItem, "stageRuns" | "stageJoins"> & { stageRuns: WorkItemStageRun[]; stageJoins: StageJoin[]; record: RunRecord | null };
type WorkflowDeps = NonNullable<WorkBoardEngineDeps["workflow"]>;

/** A real board and template store in a temp folder, a runner whose children end when the test says so, and a workspace provider that
 * hands every stage its own folder name under the run root. */
export async function stageRunHarness(opts: {
  /** Returns a result to end the child at once; undefined leaves it live until the test finishes it. */
  script?: (input: SubAgentSpawnInput) => Partial<SubAgentSpawnResult> | undefined;
  workflow?: Partial<WorkflowDeps>;
  integrate?: () => IntegrateResult | Promise<IntegrateResult>;
  /** What the engine is shown in place of the stored board row. */
  forgeRow?: (item: WorkItem) => WorkItem;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ave-stage-run-"));
  const board = new WorkBoardStore(join(dir, "board.json"));
  const templates = new WorkflowTemplateStore(join(dir, "templates.json"));
  const runs = memoryRunState();
  const forgeRow = opts.forgeRow;
  const shownBoard = forgeRow === undefined ? board : new Proxy(board, {
    get(target, key) {
      if (key !== "get") {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (id: number) => {
        const got = await target.get(id);
        return got.status === "found" ? { ...got, item: forgeRow(got.item) } : got;
      };
    },
  });
  const events: WorkBoardRunEvent[] = [];
  const children: FakeChild[] = [];
  const interrupts: string[] = [];
  const audits: Parameters<NonNullable<WorkflowDeps["audit"]>>[0][] = [];
  const unauthorised = new Set<string>();
  const workspaceCalls: string[] = [];
  const registry = boardParentToolRegistry();

  const runner = {
    async spawn(input: SubAgentSpawnInput, hooks?: { onLinked?: (link: { childSessionId: string }) => void }): Promise<SubAgentSpawnResult> {
      const sessionId = `child-${children.length + 1}`;
      let end: (result: SubAgentSpawnResult) => void = () => undefined;
      const done = new Promise<SubAgentSpawnResult>(resolve => { end = resolve; });
      const child: FakeChild = {
        input, sessionId, ended: false, steers: [],
        finish: (result = {}) => {
          if (child.ended) return;
          child.ended = true;
          end({ summary: `output of ${sessionId}`, toolCallCount: 0, turnCount: 1, childSessionId: sessionId, entries: [], ok: true, endTrustOrigin: "llm-tool-arg", ...result });
        },
      };
      children.push(child);
      await Promise.resolve();
      hooks?.onLinked?.({ childSessionId: sessionId });
      const scripted = opts.script?.(input);
      if (scripted) child.finish(scripted);
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
    sweep: async () => undefined,
  };

  /** A second call is the engine of the next process over the same files. */
  const makeEngine = () => createWorkBoardEngine({
    store: shownBoard,
    getRunner: () => runner,
    emitProgress: event => { events.push(event); },
    workflow: {
      templates, attachments: templates, runs, workspace, authoriseRunSource, passConditions: createPassConditionRegistry(),
      scopeAuthorised: scope => scope.kind === "all" || !unauthorised.has(scope.projectRoot),
      audit: event => { audits.push(event); },
      ...opts.workflow,
    },
  });
  const engine = makeEngine();

  const actor = { who: "alice", origin: "local-desktop" } as const;
  /** Confirm a new template, or the next version of `id`. Edges follow the inputs of each stage. */
  async function confirm(stages: TemplateStage[], over: { id?: string; scope?: TemplateScope; setupCommands?: string[] } = {}): Promise<TemplateVersion> {
    const edges = stages.flatMap(stage => stage.inputs.map(from => ({ from, to: stage.id })));
    const record = await templates.draft(over.id ?? null, { name: "Template", scope: over.scope ?? { kind: "all" }, stages, edges, ...(over.setupCommands ? { setupCommands: over.setupCommands } : {}) });
    if (!record.draft) throw new Error("no draft");
    return templates.confirmDraft(record.template.id, { expectedGraphHash: record.draft.graphHash, expectedDraftRevision: record.draft.revision }, actor);
  }
  const pinOf = (version: TemplateVersion): TemplateVersionPin => ({ templateId: version.templateId, version: version.version, graphHash: version.graphHash });
  async function addItem(version: TemplateVersion, projectRoot?: string): Promise<number> {
    void version;
    const created = await board.create({ title: "Work", ...(projectRoot ? { projectRoot } : {}) });
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
  async function item(itemId: number): Promise<StageRunView> {
    const got = await board.get(itemId);
    if (got.status !== "found") throw new Error("item not found");
    const record = got.item.runId === undefined ? null : await runs.get(got.item.runId);
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
  const live = () => children.filter(child => !child.ended);
  async function untilLive(count: number): Promise<FakeChild[]> {
    for (let i = 0; i < 400; i += 1) {
      if (live().length === count) return live();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${count} live children; have ${live().length}`);
  }
  async function untilSpawned(count: number): Promise<FakeChild[]> {
    for (let i = 0; i < 400; i += 1) {
      if (children.length >= count) return children;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${count} children; have ${children.length}`);
  }
  /** The event that ended the run; it follows the stored status, so a test waits for it. */
  async function settleEvent(): Promise<WorkBoardRunEvent> {
    for (let i = 0; i < 400; i += 1) {
      const event = events.find(candidate => candidate.phase === "cancelled" || candidate.phase === "done" || candidate.phase === "denied" || candidate.phase === "error");
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for the run to settle");
  }
  /** The decision the board would send for the stored gate of the stage. */
  async function decide(itemId: number, stageId: string, decision: "approve" | "reject" | "request_changes", note?: string) {
    const current = await item(itemId);
    const run = await stageRun(itemId, stageId);
    return engine.decideStageGate(itemId, { runId: current.runId ?? "", stageId, attempt: run.attempt, resultHash: run.resultHash ?? "", decision, ...(note !== undefined ? { note } : {}) });
  }
  const start = (itemId: number, source: RunAuthoritySource) => engine.runItem(itemId, { templateSource: source });

  return {
    dir, board, templates, runs, engine, makeEngine, events, children, interrupts, audits, unauthorised, workspaceCalls,
    confirm, pinOf, addItem, local, attach, detach, item, stageRun, until, untilStage, untilLive, untilSpawned, settleEvent, live, decide, statusOf, start,
    cleanup: () => cleanupTmpDir(dir),
  };
}
