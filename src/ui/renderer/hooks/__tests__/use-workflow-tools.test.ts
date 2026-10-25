import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkflowTools } from "../use-workflow-tools.js";
import type { AveApi } from "../../types.js";
import type { AgentSpawnEvent } from "../../../../tools/agent-spawn.js";

function renderWorkflowTools(
  options?: Parameters<typeof useWorkflowTools>[1],
  overrides: Partial<AveApi> = {},
) {
  let onAsk: Parameters<AveApi["onAskUserQuestion"]>[0] | undefined;
  let onSkill: Parameters<AveApi["onSkillLoaded"]>[0] | undefined;
  let onSpawn: Parameters<AveApi["onAgentSpawnEvent"]>[0] | undefined;
  const api = {
    onAskUserQuestion: vi.fn((handler: typeof onAsk) => {
      onAsk = handler;
      return () => undefined;
    }),
    onAgentSpawnEvent: vi.fn((handler: typeof onSpawn) => {
      onSpawn = handler;
      return () => undefined;
    }),
    onSkillLoaded: vi.fn((handler: typeof onSkill) => {
      onSkill = handler;
      return () => undefined;
    }),
    onAskUserQuestionTimeout: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as AveApi;
  return {
    ...renderHook(() => useWorkflowTools(api, options)),
    api,
    onAsk: (event: Parameters<NonNullable<typeof onAsk>>[0]) => onAsk?.(event),
    onSkill: (event: Parameters<NonNullable<typeof onSkill>>[0]) => onSkill?.(event),
    onSpawn: (event: AgentSpawnEvent) => onSpawn?.(event),
  };
}

function ask(id: string, sessionId: string) {
  return { id, sessionId, questions: [{ question: `${id}?`, choices: ["yes", "no"] }], createdAt: 0 };
}

describe("useWorkflowTools", () => {
  it("preserves suspension metadata when a done event transitions a spawn to waiting", () => {
    const { result, onSpawn } = renderWorkflowTools();

    act(() => {
      onSpawn?.({
        spawnId: "spawn-waiting",
        type: "start",
        taskState: "TASK_STATE_SUBMITTED",
        title: "Budgeted agent",
        parentSessionId: "session-solo",
      });
      onSpawn?.({
        spawnId: "spawn-waiting",
        type: "done",
        taskState: "TASK_STATE_INPUT_REQUIRED",
        status: "waiting",
        summary: "partial work",
        suspension: { reason: "budget", resumeId: "child-waiting" },
        parentSessionId: "session-solo",
      });
    });

    expect(result.current.subAgentSpawns).toEqual([
      expect.objectContaining({
        spawnId: "spawn-waiting",
        status: "waiting",
        suspension: { reason: "budget", resumeId: "child-waiting" },
      }),
    ]);
  });

  it("replaces a live status snapshot with cleaned entries when the child errors", () => {
    const { result, onSpawn } = renderWorkflowTools();
    const statusEntry = {
      kind: "assistant" as const,
      text: "retrying",
      streaming: true,
      phase: "status" as const,
    };

    act(() => {
      onSpawn?.({
        spawnId: "spawn-error",
        type: "start",
        taskState: "TASK_STATE_SUBMITTED",
        title: "Erroring agent",
        parentSessionId: "session-solo",
      });
      onSpawn?.({
        spawnId: "spawn-error",
        type: "activity",
        taskState: "TASK_STATE_WORKING",
        entries: [statusEntry],
        parentSessionId: "session-solo",
      });
      onSpawn?.({
        spawnId: "spawn-error",
        type: "error",
        taskState: "TASK_STATE_FAILED",
        status: "error",
        message: "child failed",
        entries: [],
        parentSessionId: "session-solo",
      });
    });

    expect(result.current.subAgentSpawns).toEqual([
      expect.objectContaining({ status: "error", entries: [] }),
    ]);
  });

  it("marks rows rebuilt from disk as restored, and a live start as not", () => {
    const { result, onSpawn } = renderWorkflowTools();

    act(() => {
      result.current.restoreSubAgentSpawns([
        { spawnId: "from-disk", childSessionId: "child-1", title: "어제의 조사", modifiedAt: "2026-09-03T00:00:00.000Z" },
      ]);
    });
    act(() => {
      onSpawn?.({ spawnId: "live-now", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "지금 조사", parentSessionId: "s-main" } as AgentSpawnEvent);
    });
    const byId = new Map(result.current.subAgentSpawns.map((spawn) => [spawn.spawnId, spawn]));
    expect(byId.get("from-disk")?.restored).toBe(true);
    expect(byId.get("live-now")?.restored).toBeUndefined();
  });

  it("a tile keeps only the sub-agent frames of the conversation it is showing", () => {
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const { result, onSpawn } = renderWorkflowTools({ ownsSession });

    act(() => {
      onSpawn?.({ spawnId: "mine", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Mine", parentSessionId: "session-mine" });
      onSpawn?.({ spawnId: "theirs", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Theirs", parentSessionId: "session-other-tile" });
      // A frame that names no conversation is one EVERY tile would keep, which
      // is N cards for one sub-agent and an act-on button in a tile that did
      // not spawn it. `parentSessionId` is required on the wire for that
      // reason; this is the runtime half of the same rule, since the type does
      // not cross the IPC boundary.
      onSpawn?.({
        spawnId: "unaddressed", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Unaddressed",
      } as unknown as AgentSpawnEvent);
      // Later phases of another tile's agent are dropped too, not synthesized.
      onSpawn?.({ spawnId: "theirs", type: "done", taskState: "TASK_STATE_COMPLETED", status: "done", summary: "x", parentSessionId: "session-other-tile" });
    });

    expect(result.current.subAgentSpawns.map((s) => s.spawnId)).toEqual(["mine"]);
  });

  it("a tile draws only the question cards of the conversations it owns", () => {
    // A tile owns its own conversation AND the child sessions of the agents it spawned — a question a sub-agent asks belongs
    // to the tile that started it.
    const ownsSession = (sessionId: string) =>
      sessionId === "session-mine" || sessionId === "child-of-mine";
    const { result, onAsk } = renderWorkflowTools({ ownsSession });

    act(() => {
      onAsk?.(ask("mine", "session-mine"));
      onAsk?.(ask("child", "child-of-mine"));
      onAsk?.(ask("theirs", "session-other-tile"));
    });

    expect(result.current.askQuestions.map((q) => q.id)).toEqual(["mine", "child"]);
  });

  it("a tile wears only the skill badges of its own conversation", () => {
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const { result, onSkill } = renderWorkflowTools({ ownsSession });

    act(() => {
      onSkill?.({ name: "mine", description: "loaded here", sessionId: "session-mine" });
      onSkill?.({ name: "theirs", description: "loaded elsewhere", sessionId: "session-other-tile" });
    });

    expect(result.current.loadedSkills.map((s) => s.name)).toEqual(["mine"]);
  });

  it("draws an adopted card while sub-agent frames stay bound to the owned session", () => {
    // What a focused tile passes: it owns one conversation, and adopts cards from any session no tile is showing (a routine
    // here).
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const drawsSession = (sessionId: string) =>
      ownsSession(sessionId) || sessionId === "session-routine";
    const { result, onAsk, onSkill, onSpawn } = renderWorkflowTools({ ownsSession, drawsSession });

    act(() => {
      onAsk?.({
        id: "routine-card",
        sessionId: "session-routine",
        questions: [{ question: "?", choices: ["yes", "no"] }],
        createdAt: 0,
      });
      onSkill?.({ name: "routine-skill", description: "loaded headless", sessionId: "session-routine" });
      // Frames keep the narrower rule: an adopted card is a prompt this tile must answer, but another session's agent list is
      // not this tile's panel.
      onSpawn?.({ spawnId: "routine-spawn", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "Routine", parentSessionId: "session-routine" });
    });

    expect(result.current.askQuestions.map((q) => q.id)).toEqual(["routine-card"]);
    expect(result.current.loadedSkills.map((s) => s.name)).toEqual(["routine-skill"]);
    expect(result.current.subAgentSpawns).toEqual([]);
  });

  it("draws questions still waiting from before it loaded, only its own, once, ahead of live ones", async () => {
    let deliverSnapshot: (parked: ReturnType<typeof ask>[]) => void = () => undefined;
    const ownsSession = (sessionId: string) => sessionId === "session-mine";
    const { result, api, onAsk } = renderWorkflowTools({ ownsSession }, {
      listPendingAskUserQuestions: vi.fn(() => new Promise<ReturnType<typeof ask>[]>((resolve) => { deliverSnapshot = resolve; })),
    });
    expect(api.listPendingAskUserQuestions).toHaveBeenCalledOnce();

    // A live question arrives while the snapshot is in flight, and is also in it.
    act(() => {
      onAsk?.(ask("live", "session-mine"));
    });
    await act(async () => {
      deliverSnapshot([ask("stranded", "session-mine"), ask("live", "session-mine"), ask("theirs", "session-other")]);
      await Promise.resolve();
    });

    expect(result.current.askQuestions.map((q) => q.id)).toEqual(["stranded", "live"]);
  });
});
