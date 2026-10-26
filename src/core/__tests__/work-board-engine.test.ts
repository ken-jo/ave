/** Use a real temporary board with an injected runner and real approval gate to test orchestration without model calls. */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
