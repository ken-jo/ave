/** LS-2 live-step events: a steer is reported delivered (with the turn that took it) or dropped only when the child's loop says so, and
 * each turn's tool steps reach the board as host-derived, bounded labels, never the tool's raw input. */
import { describe, expect, it, vi } from "vitest";
import { createWorkBoardEngine } from "../work-board-engine.js";
import type { SubAgentRunner, SubAgentSpawnCallbacks } from "../../engine/subagent-runner.js";
import type { WorkBoardRunEvent } from "../../shared/work-board-types.js";
import type { ChatEntry, ToolEntryItem } from "../../lib/chat-stream-state.js";
import type { GuidanceDropReason } from "../../engine/conversation-loop.js";
import { readRunTranscript } from "../../work-board/run-transcript.js";
import {
  runThroughDecision,
  boardParentToolRegistry,
  memTranscriptStorage,
  tempBoardStore as tempBoard,
} from "../../work-board/__tests__/board-test-fixtures.js";
import { assistantEntry } from "../../__tests__/test-helpers.js";

interface SteerObserver {
  onInjected?: () => void;
  onDropped?: (reason: GuidanceDropReason) => void;
}

/** An execute child that stays live until released, exposing its activity callback and the steer observers it was handed. */
function liveRunner() {
  const registry = boardParentToolRegistry();
  let release!: () => void;
  const settled = new Promise<void>((r) => { release = r; });
  let execCallbacks: SubAgentSpawnCallbacks | undefined;
  let linkedFired!: () => void;
  const linked = new Promise<void>((r) => { linkedFired = r; });
  const observers: SteerObserver[] = [];
  let nextMessage = 0;
  const runner = {
    async spawn(input: { profileMode?: string; originSessionId?: string }, callbacks?: SubAgentSpawnCallbacks) {
      const isPlan = input.profileMode === "plan";
      const childSessionId = `${input.originSessionId}::${isPlan ? "plan" : "exec"}`;
      callbacks?.onLinked?.({ childSessionId });
      if (isPlan) return { summary: "PLAN", toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: true };
      execCallbacks = callbacks;
      linkedFired();
      await settled;
      return { summary: "OUTPUT", toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: true };
    },
    interruptRun: () => ({ ok: true, message: "" }),
    queueHostDirectiveToWorkBoardChild(_origin: string, child: string, _text: string, observer?: SteerObserver) {
      observers.push(observer ?? {});
      nextMessage += 1;
      return { ok: true, disposition: "queued", childSessionId: child, messageId: `m-${nextMessage}` };
    },
    parentToolRegistry: () => registry,
  } as unknown as SubAgentRunner;
  const activity = (entries: ChatEntry[]) =>
    execCallbacks?.onActivity?.({ entries, toolCallCount: 0 } as Parameters<NonNullable<SubAgentSpawnCallbacks["onActivity"]>>[0]);
  return { runner, linked, release, observers, activity };
}

function toolGroup(tools: ToolEntryItem[]): ChatEntry {
  return { kind: "tool_group", groupId: `g-${tools[0]!.toolUseId}`, groupIds: [], status: "running", tools };
}

async function startExecuting() {
  const board = tempBoard();
  const created = await board.store.create({ title: "live" });
  if (created.status !== "created") throw new Error("setup failed");
  const id = created.itemId;
  const live = liveRunner();
  const events: WorkBoardRunEvent[] = [];
  const transcriptStorage = memTranscriptStorage();
  const engine = createWorkBoardEngine({
    store: board.store,
    getRunner: () => live.runner,
    emitProgress: (e) => events.push(e),
    transcriptStorage,
  });
  const run = runThroughDecision(engine, board.store, id, "approve");
  await live.linked;
  return { ...board, id, live, events, engine, run, transcriptStorage };
}

describe("WorkBoardEngine — steer acknowledgement (LS-2 G4)", () => {
  it("returns the queued steer's message id and reports it delivered with the turn that receives it", async () => {
    const ctx = await startExecuting();
    try {
      ctx.live.activity([assistantEntry("turn one"), assistantEntry("turn two")]);
      const result = ctx.engine.steerRun(ctx.id, "also cover the refresh path");
      expect(result).toEqual({ ok: true, messageId: "m-1" });
      // Queued is not delivered: nothing is reported until the child's loop injects it.
      expect(ctx.events.filter((e) => e.steer !== undefined)).toEqual([]);

      // The real order: the round that took the steer reports its activity, then the loop acknowledges the injection.
      ctx.live.activity([assistantEntry("turn one"), assistantEntry("turn two"), assistantEntry("turn three, following the steer")]);
      ctx.live.observers[0]!.onInjected?.();
      const acks = ctx.events.filter((e) => e.steer !== undefined);
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({ itemId: ctx.id, steer: { messageId: "m-1", status: "delivered", turn: 3 } });
      // The acknowledgement carries no text, turn or narration of its own.
      expect(acks[0]!.turn).toBeUndefined();
      expect(acks[0]!.text).toBeUndefined();
    } finally {
      ctx.live.release();
      await ctx.run;
      await ctx.cleanup();
    }
  });

  it("reports a steer the child's turn ended before taking as dropped, with the loop's reason", async () => {
    const ctx = await startExecuting();
    try {
      expect(ctx.engine.steerRun(ctx.id, "one more thing")).toEqual({ ok: true, messageId: "m-1" });
      ctx.live.observers[0]!.onDropped?.("turn-ended");
      const acks = ctx.events.filter((e) => e.steer !== undefined);
      expect(acks).toEqual([
        expect.objectContaining({ itemId: ctx.id, steer: { messageId: "m-1", status: "dropped", reason: "turn-ended" } }),
      ]);
    } finally {
      ctx.live.release();
      await ctx.run;
      await ctx.cleanup();
    }
  });
});

describe("WorkBoardEngine — tool steps within a turn (LS-2 G2)", () => {
  const SECRET = "sk-live-0123456789abcdef";

  it("reports each turn's tool steps as host-derived labels, never the raw input", async () => {
    const ctx = await startExecuting();
    try {
      ctx.live.activity([
        assistantEntry("I'll run the auth tests"),
        toolGroup([
          {
            toolUseId: "t1", name: "read_file", displayOrder: 0, status: "done", category: "read",
            input: { path: "/repo/src/auth/refresh.ts", token: SECRET }, durationMs: 200, startedAt: 1,
          },
          {
            toolUseId: "t2", name: "bash", displayOrder: 1, status: "running", category: "shell",
            input: { command: `npm test -- auth/refresh\nexport KEY=${SECRET}` }, startedAt: 2,
          },
        ]),
      ]);
      const withTools = ctx.events.filter((e) => e.tools !== undefined);
      expect(withTools).toHaveLength(1);
      const steps = withTools[0]!.tools!;
      expect(steps).toEqual([
        { toolUseId: "t1", name: "read_file", kind: "read", label: "refresh.ts", status: "done", turn: 1, startedAt: 1, durationMs: 200 },
        { toolUseId: "t2", name: "bash", kind: "shell", label: "npm test -- auth/refresh", status: "running", turn: 1, startedAt: 2 },
      ]);
      expect(JSON.stringify(ctx.events)).not.toContain(SECRET);
      expect(withTools[0]!.turn).toBeUndefined();

      // The same snapshot again is not a change; a status change is.
      ctx.live.activity([
        assistantEntry("I'll run the auth tests"),
        toolGroup([
          { toolUseId: "t1", name: "read_file", displayOrder: 0, status: "done", category: "read", input: { path: "/repo/src/auth/refresh.ts" }, durationMs: 200, startedAt: 1 },
          { toolUseId: "t2", name: "bash", displayOrder: 1, status: "running", category: "shell", input: { command: "npm test -- auth/refresh" }, startedAt: 2 },
        ]),
      ]);
      expect(ctx.events.filter((e) => e.tools !== undefined)).toHaveLength(1);
      ctx.live.activity([
        assistantEntry("I'll run the auth tests"),
        toolGroup([
          { toolUseId: "t1", name: "read_file", displayOrder: 0, status: "done", category: "read", input: { path: "/repo/src/auth/refresh.ts" }, durationMs: 200, startedAt: 1 },
          { toolUseId: "t2", name: "bash", displayOrder: 1, status: "done", category: "shell", input: { command: "npm test -- auth/refresh" }, startedAt: 2, durationMs: 18_000 },
        ]),
      ]);
      const latest = ctx.events.filter((e) => e.tools !== undefined).at(-1)!.tools!;
      expect(latest[1]).toMatchObject({ toolUseId: "t2", status: "done", durationMs: 18_000 });
    } finally {
      ctx.live.release();
      await ctx.run;
    }
    // Finished steps are kept in the transcript once each, for a board that opens later.
    const got = await ctx.store.get(ctx.id);
    if (got.status !== "found") throw new Error("missing item");
    const transcript = await readRunTranscript(ctx.transcriptStorage, ctx.id, got.item.runId!);
    const toolRows = transcript.filter((e) => e.kind === "tool");
    expect(toolRows.map((e) => e.tool?.toolUseId)).toEqual(["t1", "t2"]);
    expect(JSON.stringify(transcript)).not.toContain(SECRET);
    await ctx.cleanup();
  });

  it("puts a step that comes before any finished assistant text under the first turn and bounds labels to one short line", async () => {
    const ctx = await startExecuting();
    try {
      const long = "x".repeat(300);
      ctx.live.activity([
        toolGroup([{ toolUseId: "t9", name: "bash", displayOrder: 0, status: "running", category: "shell", input: { command: `${long}\nsecond line` } }]),
      ]);
      const step = ctx.events.filter((e) => e.tools !== undefined).at(-1)!.tools![0]!;
      expect(step.turn).toBe(1);
      expect(step.label!.length).toBeLessThanOrEqual(80);
      expect(step.label).not.toContain("\n");
      expect(step.label!.endsWith("…")).toBe(true);
    } finally {
      ctx.live.release();
      await ctx.run;
      await ctx.cleanup();
    }
  });
});

describe("WorkBoardEngine — run session links (LS-2 board approval claim)", () => {
  it("reports each phase child's session as it links, so the board can claim that child's tool approvals", async () => {
    const ctx = await startExecuting();
    try {
      const links = ctx.events.filter((e) => e.runSessionId !== undefined).map((e) => [e.phase, e.runSessionId]);
      expect(links).toEqual([
        ["planning", `work-board:${ctx.id}::plan`],
        ["executing", `work-board:${ctx.id}::exec`],
      ]);
      // A link reports nothing else: it is not a turn.
      const planLink = ctx.events.find((e) => e.phase === "planning" && e.runSessionId !== undefined)!;
      expect(planLink.turn).toBeUndefined();
      expect(planLink.text).toBeUndefined();
    } finally {
      ctx.live.release();
      await ctx.run;
      await ctx.cleanup();
    }
  });
});

describe("WorkBoardEngine — the planning child is recorded as it links", () => {
  it("stores the planning child's session on the item while it plans, so a board opened mid-plan can claim its approvals", async () => {
    const board = tempBoard();
    const created = await board.store.create({ title: "plan me" });
    if (created.status !== "created") throw new Error("setup failed");
    const id = created.itemId;
    const registry = boardParentToolRegistry();
    let releasePlan!: () => void;
    const planHeld = new Promise<void>((r) => { releasePlan = r; });
    let planLinked!: () => void;
    const linked = new Promise<void>((r) => { planLinked = r; });
    const runner = {
      async spawn(input: { profileMode?: string; originSessionId?: string }, callbacks?: SubAgentSpawnCallbacks) {
        const childSessionId = `${input.originSessionId}::${input.profileMode}`;
        callbacks?.onLinked?.({ childSessionId });
        if (input.profileMode === "plan") {
          planLinked();
          await planHeld;
        }
        return { summary: "DONE", toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: true };
      },
      parentToolRegistry: () => registry,
    } as unknown as SubAgentRunner;
    const engine = createWorkBoardEngine({ store: board.store, getRunner: () => runner, emitProgress: () => {} });
    try {
      const run = runThroughDecision(engine, board.store, id, "reject");
      await linked;
      await vi.waitFor(async () => {
        const got = await board.store.get(id);
        if (got.status !== "found") throw new Error("missing item");
        expect(got.item.runStatus).toBe("planning");
        expect(got.item.runSessionId).toBe(`work-board:${id}::plan`);
      });
      releasePlan();
      expect((await run).status).toBe("denied");
    } finally {
      await board.cleanup();
    }
  });
});

describe("WorkBoardEngine — a failed planning link write", () => {
  it("fails the run clearly before plan approval", async () => {
    const board = tempBoard();
    const created = await board.store.create({ title: "plan link fails" });
    if (created.status !== "created") throw new Error("setup failed");
    const id = created.itemId;
    vi.spyOn(board.store, "setRunSessionId").mockRejectedValue(new Error("disk full"));
    const registry = boardParentToolRegistry();
    const runner = {
      async spawn(input: { profileMode?: string; originSessionId?: string }, callbacks?: SubAgentSpawnCallbacks) {
        const childSessionId = `${input.originSessionId}::${input.profileMode}`;
        callbacks?.onLinked?.({ childSessionId });
        return { summary: "PLAN", toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: true };
      },
      parentToolRegistry: () => registry,
    } as unknown as SubAgentRunner;
    const events: WorkBoardRunEvent[] = [];
    const engine = createWorkBoardEngine({ store: board.store, getRunner: () => runner, emitProgress: (e) => events.push(e) });
    try {
      const result = await runThroughDecision(engine, board.store, id, "approve");
      expect(result).toMatchObject({ status: "error", reason: "disk full" });
      expect(events.some((e) => e.phase === "awaiting_approval")).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await board.cleanup();
    }
  });
});
