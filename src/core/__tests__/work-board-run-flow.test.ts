/** Verify tool scopes, lifecycle ordering, persisted session ids, profile models, and failure status with a real temporary board. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createWorkBoardEngine } from "../work-board-engine.js";
import type {
  SubAgentRunner,
  SubAgentToolScope,
} from "../../engine/subagent-runner.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { LoadedAgentProfile } from "../../main/agent-profile-store.js";
import {
  boardParentToolRegistry,
  boardApprovalGate,
} from "../../work-board/__tests__/board-test-fixtures.js";
import type { WorkBoardRunEvent } from "../../shared/work-board-types.js";

function tempBoard(): {
  store: WorkBoardStore;
  path: string;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "ave-wbrf-"));
  const path = join(dir, "board.json");
  return {
    store: new WorkBoardStore(path),
    path,
    cleanup: () => cleanupTmpDir(dir),
  };
}

interface SpawnCall {
  title: string;
  toolScopeKind: SubAgentToolScope["kind"];
  grantedToolNames?: readonly string[];
  profileMode?: string;
  profileModel?: string;
  originSessionId?: string;
}

/** Script thrown and returned failures separately; hold the plan promise to exercise single-flight behavior. */
function fakeRunner(opts?: {
  onExecute?: () => void;
  execFails?: boolean;
  holdPlan?: Promise<void>;
}): { runner: SubAgentRunner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const registry = boardParentToolRegistry();
  const runner = {
    async spawn(input: {
      title: string;
      instructions: string;
      toolScope: SubAgentToolScope;
      profileMode?: string;
      profileModel?: string;
      originSessionId?: string;
    }) {
      calls.push({
        title: input.title,
        toolScopeKind: input.toolScope.kind,
        ...(input.toolScope.kind === "exactly"
          ? { grantedToolNames: input.toolScope.names }
          : {}),
        profileMode: input.profileMode,
        profileModel: input.profileModel,
        originSessionId: input.originSessionId,
      });
      const isPlan = input.profileMode === "plan";
      if (isPlan && opts?.holdPlan) await opts.holdPlan;
      if (!isPlan) opts?.onExecute?.();
      if (!isPlan && opts?.execFails) {
        return {
          summary: "sub-agent: LLM provider not configured",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: `${input.originSessionId}::exec`,
          entries: [],
          ok: false,
          error: "sub-agent: LLM provider not configured",
        };
      }
      return {
        summary: isPlan ? "PLAN: step 1; step 2" : "OUTPUT: completed step 1; step 2",
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

function profileResolver(
  name: string,
  model: string,
): (n: string) => Promise<LoadedAgentProfile | null> {
  return async (requested) =>
    requested === name
      ? {
          name,
          description: "",
          sourceTools: [],
          triggers: [],
          model,
          body: "",
          filePath: `/fake/${name}.md`,
        }
      : null;
}

describe("WorkBoardEngine — run-flow contracts", () => {
  it("scopes the PLAN registry read-only and grants EXECUTE the full registry", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "scoping check" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { approvalSurface: owner });
      expect(result.status).toBe("completed");
      expect(calls).toHaveLength(2);

      const planCall = calls[0];
      expect(planCall.profileMode).toBe("plan");
      expect(planCall.toolScopeKind).toBe("exactly");
      expect(planCall.grantedToolNames!.length).toBeGreaterThan(0);
      expect(planCall.grantedToolNames).toContain("read_file");
      expect(planCall.grantedToolNames).toContain("sample_lookup");
      for (const forbidden of [
        "write_file",
        "run_shell",
        "web_fetch",
        "agent_spawn",
      ]) {
        expect(planCall.grantedToolNames).not.toContain(forbidden);
      }

      // Execution explicitly receives parent-all; the runner still strips agent_spawn.
      const execCall = calls[1];
      expect(execCall.profileMode).toBe("execute");
      expect(execCall.toolScopeKind).toBe("parent-all");
    } finally {
      await cleanup();
    }
  });

  it("derives the PLAN grant from tool CATEGORY, so a plugin's read tool is in and web_fetch is out", async () => {
    // Derive plan grants from read-tier registry categories, including plugin tools; network is not read-tier.
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "category derivation" });
      if (created.status !== "created") throw new Error("setup failed");

      const { runner, calls } = fakeRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      expect((await engine.runItem(created.itemId, { approvalSurface: owner })).status).toBe("completed");
      const granted = calls[0].grantedToolNames;

      expect(granted).toEqual(expect.arrayContaining(["read_file", "grep_files", "sample_lookup"]));
      expect(granted).not.toContain("write_file");
      expect(granted).not.toContain("run_shell");
      expect(granted).not.toContain("web_fetch");
      expect(granted).not.toContain("agent_spawn");
    } finally {
      await cleanup();
    }
  });

  it("stops the run rather than widening when the registry holds no read-tier tool", async () => {
    // An empty exact grant must fail visibly, never widen permissions.
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "empty derivation" });
      if (created.status !== "created") throw new Error("setup failed");

      const { runner, calls } = fakeRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => ({
          ...runner,
          parentToolRegistry: () => new ToolRegistry(),
        } as unknown as SubAgentRunner),
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(created.itemId, { approvalSurface: owner });
      expect(result.status).toBe("error");
      expect(result.reason).toContain("read-tier");
      expect(calls).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("emits progress events in lifecycle order on the approve path", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "ordered events" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner } = fakeRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      await engine.runItem(id, { approvalSurface: owner });

      // Ignore repeated turn updates when comparing phase-entry order.
      const order: WorkBoardRunEvent["phase"][] = [];
      for (const e of events) {
        if (!order.includes(e.phase)) order.push(e.phase);
      }
      expect(order).toEqual([
        "planning",
        "awaiting_approval",
        "executing",
        "done",
      ]);

      const approvalIdx = events.findIndex((e) => e.phase === "awaiting_approval");
      const executingIdx = events.findIndex((e) => e.phase === "executing");
      expect(approvalIdx).toBeGreaterThanOrEqual(0);
      expect(executingIdx).toBeGreaterThan(approvalIdx);

      const done = events[events.length - 1];
      expect(done.phase).toBe("done");
      expect(done.runSessionId).toBe(`work-board:${id}::exec`);
    } finally {
      await cleanup();
    }
  });

  it("on reject: runStatus=denied, no execute spawn, no executing event", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "rejected run" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("deny-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id, { approvalSurface: owner });

      expect(result.status).toBe("denied");
      expect(calls).toHaveLength(1);
      expect(calls[0].profileMode).toBe("plan");
      expect(requests).toHaveLength(1);

      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain("executing");
      expect(phases).not.toContain("done");
      expect(phases[phases.length - 1]).toBe("denied");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("denied");
      expect(got.item.output).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("persists the run session id durably (survives a fresh store re-read)", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "persist session" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner } = fakeRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { approvalSurface: owner });
      expect(result.status).toBe("completed");
      const expectedSession = `work-board:${id}::exec`;
      expect(result.runSessionId).toBe(expectedSession);

      // Reopen with another store instance to prove run fields reached disk.
      const reloaded = new WorkBoardStore(path);
      const got = await reloaded.get(id);
      if (got.status !== "found") throw new Error("missing item after reload");
      expect(got.item.runStatus).toBe("completed");
      expect(got.item.runSessionId).toBe(expectedSession);
      expect(got.item.plan).toBe("PLAN: step 1; step 2");
      expect(got.item.output).toBe("OUTPUT: completed step 1; step 2");
      expect(got.item.runUpdatedAt).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("threads a named agent profile's model into both child phases", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "profile model" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        getAgentProfile: profileResolver("researcher", "high"),
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { approvalSurface: owner, agentName: "researcher" });
      expect(result.status).toBe("completed");

      expect(calls).toHaveLength(2);
      expect(calls[0].profileModel).toBe("high");
      expect(calls[1].profileModel).toBe("high");
    } finally {
      await cleanup();
    }
  });

  it("errors when a named profile cannot be resolved (no spawn, no approval)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "missing profile" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        getAgentProfile: profileResolver("known", "high"),
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { approvalSurface: owner, agentName: "does-not-exist" });

      expect(result.status).toBe("error");
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
    } finally {
      await cleanup();
    }
  });

  it("lands runStatus=error when the EXECUTE phase throws (no done event)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "execute throws" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner, calls } = fakeRunner({
        onExecute: () => {
          throw new Error("boom in execute");
        },
      });
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id, { approvalSurface: owner });

      expect(result.status).toBe("error");
      expect(result.reason).toContain("boom in execute");
      expect(calls).toHaveLength(2);
      expect(calls[1].profileMode).toBe("execute");

      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain("done");
      expect(phases).toContain("error");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
      expect(got.item.output).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("lands runStatus=error when the EXECUTE sub-agent signals failure (ok:false, not a thrown error)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "execute fails" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      // Returned ok:false is a failed run; never persist its summary as successful output.
      const { runner, calls } = fakeRunner({ execFails: true });
      const { gate, owner } = boardApprovalGate("allow-once");
      const events: WorkBoardRunEvent[] = [];
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: (e) => events.push(e),
      });

      const result = await engine.runItem(id, { approvalSurface: owner });

      expect(result.status).toBe("error");
      expect(result.reason).toContain("provider not configured");
      expect(calls).toHaveLength(2);
      expect(calls[1].profileMode).toBe("execute");

      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain("done");
      expect(phases).toContain("error");

      const got = await store.get(id);
      if (got.status !== "found") throw new Error("missing item");
      expect(got.item.runStatus).toBe("error");
      expect(got.item.output).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("rejects a concurrent run of the same item (busy) and does NOT spawn a second agent", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "single flight" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      let releasePlan!: () => void;
      const holdPlan = new Promise<void>((resolve) => {
        releasePlan = resolve;
      });
      const { runner, calls } = fakeRunner({ holdPlan });
      const { gate, owner } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const firstRun = engine.runItem(id, { approvalSurface: owner });
      // Wait for the first plan spawn before issuing the concurrent run.
      while (calls.length === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      const busy = await engine.runItem(id, { approvalSurface: owner });
      expect(busy.status).toBe("already_running");
      expect(calls).toHaveLength(1);

      releasePlan();
      const first = await firstRun;
      expect(first.status).toBe("completed");
      expect(calls).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("rejects a run when the persisted runStatus is already active (executing)", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "persisted active" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;
      await store.setRunStatus(id, "executing");

      const { runner, calls } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const result = await engine.runItem(id, { approvalSurface: owner });
      expect(result.status).toBe("already_running");
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("clears stale run fields at run START: completed → re-run → deny leaves no residual output/runSessionId", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "stale fields" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      {
        const { runner } = fakeRunner();
        const { gate, owner } = boardApprovalGate("allow-once");
        const engine = createWorkBoardEngine({
          store,
          getRunner: () => runner,
          approvalGate: gate,
          emitProgress: () => {},
        });
        const result = await engine.runItem(id, { approvalSurface: owner });
        expect(result.status).toBe("completed");
      }
      const afterComplete = await store.get(id);
      if (afterComplete.status !== "found") throw new Error("missing item");
      expect(afterComplete.item.runStatus).toBe("completed");
      expect(afterComplete.item.output).toBe("OUTPUT: completed step 1; step 2");
      const completedSession = afterComplete.item.runSessionId;
      expect(completedSession).toBeDefined();

      {
        const { runner } = fakeRunner();
        const { gate, owner } = boardApprovalGate("deny-once");
        const engine = createWorkBoardEngine({
          store,
          getRunner: () => runner,
          approvalGate: gate,
          emitProgress: () => {},
        });
        const result = await engine.runItem(id, { approvalSurface: owner });
        expect(result.status).toBe("denied");
      }

      const afterDeny = await store.get(id);
      if (afterDeny.status !== "found") throw new Error("missing item");
      expect(afterDeny.item.runStatus).toBe("denied");
      expect(afterDeny.item.output).toBeUndefined();
      expect(afterDeny.item.runSessionId).not.toBe(completedSession);
    } finally {
      await cleanup();
    }
  });

  it("requires a fresh plan approval every run and offers no standing grant", async () => {
    const { store, cleanup } = tempBoard();
    try {
      const created = await store.create({ title: "no remembered bypass" });
      if (created.status !== "created") throw new Error("setup failed");
      const id = created.itemId;

      const { runner } = fakeRunner();
      const { gate, owner, requests } = boardApprovalGate("allow-once");
      const engine = createWorkBoardEngine({
        store,
        getRunner: () => runner,
        approvalGate: gate,
        emitProgress: () => {},
      });

      const first = await engine.runItem(id, { approvalSurface: owner });
      expect(first.status).toBe("completed");
      const second = await engine.runItem(id, { approvalSurface: owner });
      expect(second.status).toBe("completed");

      expect(requests).toHaveLength(2);
      const ids = requests.map((r) => (r as { id: string }).id);
      expect(ids[0]).not.toBe(ids[1]);
      for (const r of requests) {
        expect((r as { toolName: string }).toolName).toBe("work_board_run");
        expect((r as { kind: string }).kind).toBe("agent-action");
        expect((r as { allowedChoices?: unknown }).allowedChoices).toEqual([
          "allow-once",
          "deny-once",
        ]);
        expect((r as { durableApprovalRecordAllowed?: unknown }).durableApprovalRecordAllowed).toBe(false);
      }
    } finally {
      await cleanup();
    }
  });
});
