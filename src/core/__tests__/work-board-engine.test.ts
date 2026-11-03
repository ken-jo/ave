/** Use a real temporary board with an injected runner and real approval gate to test orchestration without model calls. */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createWorkBoardEngine } from "../work-board-engine.js";
import type {
  SubAgentRunner,
  SubAgentSpawnCallbacks,
  SubAgentToolScope,
} from "../../engine/subagent-runner.js";
import type { WorkBoardRunEvent } from "../../shared/work-board-types.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
import { readRunTranscript } from "../../work-board/run-transcript.js";
import {
  boardParentToolRegistry,
  memTranscriptStorage,
  boardApprovalGate,
  tempBoardStore as tempBoard,
} from "../../work-board/__tests__/board-test-fixtures.js";
import { assistantEntry } from "../../__tests__/test-helpers.js";

interface SpawnCall {
  title: string;
  toolScopeKind: SubAgentToolScope["kind"];
  grantedToolNames?: readonly string[];
  profileMode?: string;
  originSessionId?: string;
  projectRoot?: string;
}

function fakeRunner(): { runner: SubAgentRunner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const registry = boardParentToolRegistry();
  const runner = {
    async spawn(input: {
      title: string;
      toolScope: SubAgentToolScope;
      profileMode?: string;
      originSessionId?: string;
      projectRoot?: string;
    }) {
      calls.push({
        title: input.title,
        toolScopeKind: input.toolScope.kind,
        ...(input.toolScope.kind === "exactly"
          ? { grantedToolNames: input.toolScope.names }
          : {}),
        profileMode: input.profileMode,
        originSessionId: input.originSessionId,
        projectRoot: input.projectRoot,
      });
      const isPlan = input.profileMode === "plan";
      return {
        summary: isPlan ? "PLAN: do A then B" : "OUTPUT: did A then B",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId: `${input.originSessionId}::${isPlan ? "plan" : "exec"}`,
        entries: [],
        ok: true,
      };
    },
    parentToolRegistry: () => registry,
  } as unknown as SubAgentRunner;
  return { runner, calls };
}

describe("WorkBoardEngine — plan→approve→execute", () => {
  it("denies an authenticated standing-grant answer that the plan card did not offer", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "one plan at a time" });
      if (created.status !== "created") throw new Error("setup failed");
      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-always");
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: () => {} });
      const result = await engine.runItem(created.itemId, { approvalSurface: owner });
      expect(result.status).toBe("denied");
      expect(result.reason).toBe("approval choice not allowed");
      expect(calls).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].allowedChoices).toEqual(["allow-once", "deny-once"]);
    } finally {
      await cleanup();
    }
  });

  it("runs the full sequence on approval and persists plan + output", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const projectRoot = join(tmpdir(), "agent-connector");
      const created = await store.create({ title: "ship feature", projectRoot });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id, { approvalSurface: owner });

      expect(result.status).toBe("completed");
      expect(result.plan).toBe("PLAN: do A then B");
      expect(result.output).toBe("OUTPUT: did A then B");
      expect(result.runSessionId).toBe(`work-board:${id}::exec`);

      expect(calls).toHaveLength(2);
      expect(calls[0].profileMode).toBe("plan");
      expect(calls[0].grantedToolNames).toContain("read_file");
      expect(calls[0].grantedToolNames).not.toContain("write_file");
      expect(calls[1].profileMode).toBe("execute");
      expect(calls[1].toolScopeKind).toBe("parent-all");
      expect(calls[0].originSessionId).toBe(`work-board:${id}`);
      expect(calls[0].projectRoot).toBe(projectRoot);
      expect(calls[1].projectRoot).toBe(projectRoot);

      expect(requests).toHaveLength(1);
      const req = requests[0];
      expect(req.kind).toBe("agent-action");
      expect(req.toolCategory).toBe("meta");
      expect((req.args as { plan: string }).plan).toBe("PLAN: do A then B");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("completed");
      expect(got.item.plan).toBe("PLAN: do A then B");
      expect(got.item.output).toBe("OUTPUT: did A then B");
      expect(got.item.runSessionId).toBe(`work-board:${id}::exec`);

      const phases = events.map((e) => e.phase);
      expect(phases).toContain("planning");
      expect(phases).toContain("awaiting_approval");
      expect(phases).toContain("executing");
      expect(phases[phases.length - 1]).toBe("done");
    } finally {
      await cleanup();
    }
  });

  it("runs an ACCEPTED PROPOSAL through the same gate, and one approval never becomes a standing grant", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const posted = await store.upsertProposal(
        { pluginId: "indexer", pluginLabel: "Indexer", grantedKinds: ["stale-index"] },
        {
          kind: "stale-index",
          key: "folder:reports",
          title: "Re-index the reports folder",
          summary: "18 files changed since the last scan.",
          state: "Last scanned 12 days ago.",
          taskBrief: "Re-run the folder scan and report what changed.",
        },
      );
      if (posted.status !== "ok") throw new Error("setup failed");
      const accepted = await store.acceptProposal(posted.proposal.id);
      if (accepted.status !== "accepted") throw new Error("setup failed");

      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const first = await engine.runItem(accepted.itemId, { approvalSurface: owner });
      expect(first.status).toBe("completed");
      // Plugin-supplied plan text must not gain mutating tools before approval.
      expect(calls[0].profileMode).toBe("plan");
      expect(calls[0].grantedToolNames).toContain("read_file");

      const req = requests[0];
      expect(req.allowedChoices).toEqual(["allow-once", "deny-once"]);
      expect(req.durableApprovalRecordAllowed).toBe(false);

      // A later run must ask again; a prior answer must not disable future plan approvals.
      const second = await engine.runItem(accepted.itemId, { approvalSurface: owner });
      expect(second.status).toBe("completed");
      expect(requests).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("stops at denial — no execute spawn, runStatus=denied", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "risky op" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, owner } = boardApprovalGate("deny-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id, { approvalSurface: owner });

      expect(result.status).toBe("denied");
      expect(result.plan).toBe("PLAN: do A then B");
      expect(calls).toHaveLength(1);
      expect(calls[0].profileMode).toBe("plan");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("denied");
      expect(got.item.plan).toBe("PLAN: do A then B");
      expect(got.item.output).toBeUndefined();

      expect(events[events.length - 1].phase).toBe("denied");
    } finally {
      await cleanup();
    }
  });

  it("returns not_found for an unknown id (no spawn, no approval)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(9999, { approvalSurface: owner });

      expect(result.status).toBe("not_found");
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("returns error when the runner is not yet wired", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "early call" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => undefined,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { approvalSurface: owner });
      expect(result.status).toBe("error");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
    } finally {
      await cleanup();
    }
  });

  // Forward only new completed rounds; tool and streaming callbacks must not create blank or duplicate transcript rows.

  function streamingAssistant(text: string): ChatEntry {
    return { kind: "assistant", text, streaming: true };
  }
  function runningTool(id: string): ChatEntry {
    return {
      kind: "tool_group",
      groupId: id,
      groupIds: [id],
      status: "running",
      tools: [],
    };
  }

  /** Repeat activity within a round to expose naive forwarding of zero or duplicate turn numbers. */
  function floodingRunner(): SubAgentRunner {
    const registry = boardParentToolRegistry();
    return {
      parentToolRegistry: () => registry,
      async spawn(
        input: { profileMode?: string; originSessionId?: string },
        callbacks?: SubAgentSpawnCallbacks,
      ) {
        const isPlan = input.profileMode === "plan";
        const fire = (entries: ChatEntry[]) =>
          callbacks?.onActivity?.({ entries, toolCallCount: 0 });
        fire([runningTool("g1")]);
        fire([runningTool("g1"), streamingAssistant("thinking…")]);
        fire([runningTool("g1"), assistantEntry("round one")]);
        fire([runningTool("g1"), assistantEntry("round one"), runningTool("g2")]);
        fire([
          runningTool("g1"),
          assistantEntry("round one"),
          runningTool("g2"),
          assistantEntry("round two"),
        ]);
        return {
          summary: isPlan ? "PLAN: do A then B" : "OUTPUT: did A then B",
          toolCallCount: 0,
          turnCount: 2,
          childSessionId: `${input.originSessionId}::${isPlan ? "plan" : "exec"}`,
          entries: [],
          ok: true,
        };
      },
    } as unknown as SubAgentRunner;
  }

  it("does not flood: no blank turn:0 and no duplicate turn rows (live events + persisted transcript)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "flooding guard" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const runner = floodingRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const transcriptStorage = memTranscriptStorage();
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
        transcriptStorage,
      });

      const result = await engine.runItem(id, { approvalSurface: owner });
      expect(result.status).toBe("completed");

      const turnEvents = events.filter((e) => e.turn !== undefined);
      expect(turnEvents.length).toBeGreaterThan(0);
      for (const e of turnEvents) {
        expect(e.turn).toBeGreaterThanOrEqual(1); // no blank turn:0
        expect(e.text ?? "").not.toBe(""); // no empty-text turn frame
      }
      const seen = new Set<string>();
      for (const e of turnEvents) {
        const key = `${e.phase}:${e.turn}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      const planTurns = turnEvents
        .filter((e) => e.phase === "planning")
        .map((e) => e.turn);
      const execTurns = turnEvents
        .filter((e) => e.phase === "executing")
        .map((e) => e.turn);
      expect(planTurns).toEqual([1, 2]);
      expect(execTurns).toEqual([1, 2]);

      const runFile = Object.keys(transcriptStorage.files).find((p) =>
        p.startsWith(`sessions/${id}/`),
      );
      expect(runFile).toBeDefined();
      const runId = runFile!.replace(`sessions/${id}/`, "").replace(/\.jsonl$/, "");
      const recorded = await readRunTranscript(transcriptStorage, id, runId);
      const recordedTurns = recorded.filter((e) => e.kind === "turn");
      expect(recordedTurns.length).toBeGreaterThan(0);
      for (const e of recordedTurns) {
        expect(e.turn ?? 0).toBeGreaterThanOrEqual(1); // no blank turn:0 rows
        expect(e.text ?? "").not.toBe("");
      }
      const recordedKeys = recordedTurns.map((e) => `${e.phase}:${e.turn}`);
      expect(new Set(recordedKeys).size).toBe(recordedKeys.length); // no dupes
    } finally {
      await cleanup();
    }
  });
});

/** The execute child links before its first round; the runner holds the run open until the test releases it. */
function linkingRunner(): {
  runner: SubAgentRunner;
  release: () => void;
  linked: Promise<string>;
} {
  const registry = boardParentToolRegistry();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let onLinkedFired!: (id: string) => void;
  const linked = new Promise<string>((r) => { onLinkedFired = r; });
  const runner = {
    async spawn(
      input: { profileMode?: string; originSessionId?: string },
      callbacks?: SubAgentSpawnCallbacks,
    ) {
      const isPlan = input.profileMode === "plan";
      const childSessionId = `${input.originSessionId}::${isPlan ? "plan" : "exec"}`;
      callbacks?.onLinked?.({ childSessionId });
      if (!isPlan) {
        onLinkedFired(childSessionId);
        await released;
      }
      return {
        summary: isPlan ? "PLAN" : "OUTPUT",
        toolCallCount: 0,
        turnCount: 1,
        childSessionId,
        entries: [],
        ok: true,
      };
    },
    parentToolRegistry: () => registry,
  } as unknown as SubAgentRunner;
  return { runner, release, linked };
}

describe("WorkBoardEngine — execute child id is exposed when it links (WB-1)", () => {
  it("emits the execute child id on an executing event and persists it while the run is still executing", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "live session" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, release, linked } = linkingRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: (e) => events.push(e) });

      const run = engine.runItem(id, { approvalSurface: owner });
      const execChild = await linked;
      expect(execChild).toBe(`work-board:${id}::exec`);

      const linkedEvent = events.find((e) => e.phase === "executing" && e.runSessionId !== undefined);
      expect(linkedEvent?.runSessionId).toBe(execChild);
      // The plan child id stored at approval time must be replaced by the execute child id mid-run.
      await vi.waitFor(async () => {
        const got = await store.get(id);
        if (got.status !== "found") throw new Error("missing item");
        expect(got.item.runStatus).toBe("executing");
        expect(got.item.runSessionId).toBe(execChild);
      });

      release();
      expect((await run).status).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  it("records one activity entry per phase: the link write appends none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-wb-link-activity-"));
    const store = new WorkBoardStore(join(dir, "board.json"));
    try {
      const created = await store.create({ title: "one entry per phase" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, release, linked } = linkingRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: () => {} });
      const run = engine.runItem(id, { approvalSurface: owner });
      await linked;
      release();
      expect((await run).status).toBe("completed");

      const runEntries = readFileSync(join(dir, "activity.jsonl"), "utf-8").trim().split("\n")
        .map((line) => JSON.parse(line) as { kind: string; to?: string; itemId?: number })
        .filter((e) => e.itemId === id && e.kind.startsWith("run-"))
        .map((e) => `${e.kind}:${e.to}`);
      expect(runEntries).toEqual([
        "run-planned:planning",
        "run-planned:awaiting_approval",
        "run-planned:executing",
        "run-executed:completed",
      ]);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("fails the run clearly when the link write fails, even though the child finished", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "link write fails" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      vi.spyOn(store, "setRunSessionId").mockRejectedValue(new Error("disk full"));
      const { runner, release, linked } = linkingRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: (e) => events.push(e) });

      const run = engine.runItem(id, { approvalSurface: owner });
      await linked;
      release();
      const result = await run;
      expect(result).toMatchObject({ status: "error", reason: "disk full" });
      expect(events.at(-1)).toMatchObject({ phase: "error", message: "disk full" });
      expect(events.some((e) => e.phase === "done")).toBe(false);
      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
      expect(got.item.output).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  });
});

/** An execute child that stays live until released or interrupted; interruption mirrors the runner's interrupted result, including its onError notice. */
function controllableRunner(): {
  runner: SubAgentRunner;
  linked: Promise<string>;
  release: () => void;
  interruptCalls: Array<[string, string]>;
  steerCalls: Array<[string, string, string]>;
  interruptAccepted: { value: boolean };
} {
  const registry = boardParentToolRegistry();
  let release!: () => void;
  let interrupt!: () => void;
  const settled = new Promise<"released" | "interrupted">((r) => {
    release = () => r("released");
    interrupt = () => r("interrupted");
  });
  let onLinkedFired!: (id: string) => void;
  const linked = new Promise<string>((r) => { onLinkedFired = r; });
  const interruptCalls: Array<[string, string]> = [];
  const steerCalls: Array<[string, string, string]> = [];
  const interruptAccepted = { value: true };
  const runner = {
    async spawn(input: { profileMode?: string; originSessionId?: string }, callbacks?: SubAgentSpawnCallbacks) {
      const isPlan = input.profileMode === "plan";
      const childSessionId = `${input.originSessionId}::${isPlan ? "plan" : "exec"}`;
      callbacks?.onLinked?.({ childSessionId });
      if (isPlan) {
        return { summary: "PLAN", toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: true };
      }
      onLinkedFired(childSessionId);
      const how = await settled;
      if (how === "interrupted") {
        callbacks?.onError?.("sub-agent run interrupted");
        return {
          summary: "sub-agent run interrupted", error: "sub-agent run interrupted", stopReason: "interrupted",
          toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: false,
        };
      }
      return { summary: "OUTPUT", toolCallCount: 0, turnCount: 1, childSessionId, entries: [], ok: true };
    },
    interruptRun(id: string, origin: string) {
      interruptCalls.push([id, origin]);
      if (!interruptAccepted.value) return { ok: false, message: `sub-agent run is not running: ${id}` };
      interrupt();
      return { ok: true, message: `interrupt requested for sub-agent run: ${id}` };
    },
    queueHostDirectiveToWorkBoardChild(origin: string, child: string, text: string) {
      steerCalls.push([origin, child, text]);
      return { ok: true, disposition: "queued", childSessionId: child, messageId: "m-1" };
    },
    parentToolRegistry: () => registry,
  } as unknown as SubAgentRunner;
  return { runner, linked, release, interruptCalls, steerCalls, interruptAccepted };
}

describe("WorkBoardEngine — steer and stop a running execution (WB-3)", () => {
  it("refuses steer and stop when nothing is executing, including while the plan awaits approval", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "idle" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, steerCalls, interruptCalls } = controllableRunner();
      let answer!: (choice: "allow-once" | "deny-once") => void;
      const gate = {
        requestAndWait: () => new Promise((r) => { answer = (choice) => r({ choice }); }),
      } as unknown as Parameters<typeof createWorkBoardEngine>[0]["approvalGate"];
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: (e) => events.push(e) });

      expect(await engine.steerRun(id, "go faster")).toEqual({ ok: false, reason: "not-executing" });
      expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });

      const run = engine.runItem(id);
      await vi.waitFor(() => expect(events.some((e) => e.phase === "awaiting_approval")).toBe(true));
      expect(await engine.steerRun(id, "go faster")).toEqual({ ok: false, reason: "not-executing" });
      expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-executing" });
      answer("deny-once");
      expect((await run).status).toBe("denied");
      expect(steerCalls).toEqual([]);
      expect(interruptCalls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("records the execute child when it links and forgets it when the run settles", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "record the child" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, linked, release } = controllableRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: () => {} });
      expect(engine.executingChildSessionId(id)).toBeUndefined();
      const run = engine.runItem(id, { approvalSurface: owner });
      const child = await linked;
      expect(engine.executingChildSessionId(id)).toBe(child);
      release();
      expect((await run).status).toBe("completed");
      expect(engine.executingChildSessionId(id)).toBeUndefined();
      expect(engine.steerRun(id, "too late")).toEqual({ ok: false, reason: "not-executing" });
    } finally {
      await cleanup();
    }
  });

  it("steers the host-recorded execute child of this item", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "steer me" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, linked, release, steerCalls } = controllableRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: () => {} });
      const run = engine.runItem(id, { approvalSurface: owner });
      const child = await linked;
      expect(await engine.steerRun(id, "also cover the edge cases")).toEqual({ ok: true });
      expect(steerCalls).toEqual([[`work-board:${id}`, child, "also cover the edge cases"]]);
      release();
      expect((await run).status).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  it("stops the execute child: interrupts it, settles as cancelled (never error), and records the user stop", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "stop me" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, linked, interruptCalls } = controllableRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const transcriptStorage = memTranscriptStorage();
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: (e) => events.push(e), transcriptStorage });
      const run = engine.runItem(id, { approvalSurface: owner });
      const child = await linked;

      expect(engine.cancelRun(id)).toEqual({ ok: true });
      expect(interruptCalls).toEqual([[child, `work-board:${id}`]]);
      const result = await run;
      expect(result.status).toBe("cancelled");

      expect(events.filter((e) => e.phase === "error")).toEqual([]);
      expect(events.filter((e) => e.phase === "cancelled")).toHaveLength(1);
      expect(events[events.length - 1].phase).toBe("cancelled");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("cancelled");
      const entry = got.item.runHistory?.at(-1);
      expect(entry?.status).toBe("cancelled");
      expect(entry?.endedAt).toBeDefined();

      const runId = got.item.runId!;
      const recorded = await readRunTranscript(transcriptStorage, id, runId);
      expect(recorded.at(-1)).toMatchObject({ phase: "cancelled", kind: "decision", message: "user-stopped" });
      expect(engine.executingChildSessionId(id)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("reports a refused interrupt and keeps the run's outcome its own", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "already ending" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      const { runner, linked, release, interruptAccepted } = controllableRunner();
      interruptAccepted.value = false;
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: () => {} });
      const run = engine.runItem(id, { approvalSurface: owner });
      await linked;
      expect(engine.cancelRun(id)).toEqual({ ok: false, reason: "not-running" });
      release();
      expect((await run).status).toBe("completed");
    } finally {
      await cleanup();
    }
  });
});
