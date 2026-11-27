import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withInProcessFileQueue } from "../../../lib/with-file-lock.js";
import * as storage from "../../../main/storage/rewrite-keeping-bytes.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { boardRunState } from "../run-state.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

async function provisionalItem(h: Awaited<ReturnType<typeof stageRunHarness>>, templateId: string, authority: { refreshCurrent(): Promise<boolean>; isCurrent(): boolean }) {
  const created = await h.board.create({ title: "Work", templateId }, authority);
  if (created.status !== "created" || !created.item.remoteProvisional) throw new Error("Provisional item not created");
  return { itemId: created.itemId, remoteProvisional: created.item.remoteProvisional };
}

it("links descendants of a remotely started stage after the provisional launch commits", async () => {
  const bound = new Map<string, string>();
  const h = await stageRunHarness({
    observeRunWork: true,
    workflow: {
      workspaceBinding: { bind: (id, root) => { bound.set(id, root); }, unbind: id => { bound.delete(id); } },
    },
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: true })]);
    const authority = { refreshCurrent: async () => true, isCurrent: () => true };
    const { itemId, remoteProvisional } = await provisionalItem(h, version.templateId, authority);
    const accepted = deferred<string>();
    const run = h.engine.runItem(itemId, {
      templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) },
      authority, remoteProvisional, onTemplateStarted: accepted.resolve,
    });
    const [stage] = await h.untilLive(1, itemId);
    const item = await h.item(itemId);
    expect(item.remoteProvisional).toBeUndefined();
    expect(await accepted.promise).toBe(item.runId);
    expect(stage.input.stageSubAgents).toMatchObject({ runKey: `work-board:${itemId}#${item.runId}`, stageName: "Stage a" });
    const link = stage.callbacks?.onStageSubAgentLinked;
    if (!link) throw new Error("No sub-agent link for the opted-in stage");
    const release = link("grandchild", "Extract");
    expect(bound.get("grandchild")).toBe(stage.input.projectRoot);
    expect(h.events).toContainEqual(expect.objectContaining({ itemId, stageId: "a", runSessionId: stage.sessionId, subAgentSessionId: "grandchild" }));
    release();
    expect(bound.has("grandchild")).toBe(false);
    stage.finish();
    expect(await run).toMatchObject({ status: "completed" });
    expect(bound.size).toBe(0);
    expect(h.children).toHaveLength(1);
  });
});

it.each([
  { kind: "gate", failure: "refresh" },
  { kind: "gate", failure: "commit" },
  { kind: "join", failure: "refresh" },
  { kind: "join", failure: "commit" },
  { kind: "start", failure: "refresh" },
  { kind: "start", failure: "commit" },
] as const)("refuses revoked $kind authority after a queued write waits ($failure)", async ({ kind, failure }) => {
  const waiting = deferred<void>();
  const release = deferred<void>();
  let armed = false;
  let current = true;
  let integrations = 0;
  let blocker: Promise<void> | undefined;
  const authority = {
    refreshCurrent: async () => failure === "commit" || current,
    isCurrent: () => failure === "refresh" || current,
  };
  async function queueWrite<T>(write: () => Promise<T>): Promise<T> {
    if (!armed || failure !== "refresh") return write();
    armed = false;
    const holding = deferred<void>();
    blocker = withInProcessFileQueue(runFile, async () => {
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const pending = write();
    waiting.resolve();
    return pending;
  }
  const h = await stageRunHarness({
    observeRunWork: true,
    integrate: () => {
      integrations++;
      return { ok: false, conflict: { conflictHash: "c".repeat(64), reason: "merge-conflict", files: [] } };
    },
  });
  const put = h.board.runs.put.bind(h.board.runs);
  const settle = h.board.runs.settleRun.bind(h.board.runs);
  const enqueueWrite = kind === "start"
    ? vi.spyOn(h.board.runs, "put").mockImplementation((...args) => queueWrite(() => put(...args)))
    : vi.spyOn(h.board.runs, "settleRun").mockImplementation((...args) => queueWrite(() => settle(...args)));
  const runFile = join(h.dir, "workflow-runs.json");
  const rewrite = storage.rewriteKeepingBytes;
  const spy = vi.spyOn(storage, "rewriteKeepingBytes").mockImplementation(async (...args) => {
    if (armed && failure === "commit" && args[0] === runFile) {
      armed = false;
      waiting.resolve();
      await release.promise;
    }
    return rewrite(...args);
  });
  await h.runThenEnd(async () => {
    try {
      const version = await h.confirm([
        kind === "join" ? autoStageOf("a") : stageOf("a"), stageOf("b", { inputs: ["a"] }),
      ]);
      if (kind === "start") {
        const { itemId, remoteProvisional } = await provisionalItem(h, version.templateId, authority);
        armed = true;
        const start = h.engine.runItem(itemId, { templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) }, authority, remoteProvisional });
        await waiting.promise;
        current = false;
        release.resolve();
        const result = await Promise.race([start, h.untilSpawned(1, itemId).then(() => ({ status: "child-started" }))]);
        expect(result).toMatchObject({ status: "error", reasonCode: "remote-controller-authority-revoked" });
        expect((await h.item(itemId)).runId).toBeUndefined();
        expect(h.children).toHaveLength(0);
        return;
      }

      const itemId = await h.addItem(version);
      const start = h.start(itemId, h.local(version));
      (await h.untilLive(1, itemId))[0].finish();
      await start;
      const parked = await h.item(itemId);
      const runId = parked.runId ?? "";
      const decide = kind === "gate"
        ? () => h.engine.decideStageGate(itemId, {
          runId, stageId: "a", attempt: 1, resultHash: parked.stageRuns[0].resultHash ?? "", decision: "approve",
        }, { kind: "tailnet", authority })
        : () => h.engine.decideStageJoin(itemId, {
          runId, joinId: parked.stageJoins[0].joinId, conflictHash: parked.stageJoins[0].conflict?.conflictHash ?? "",
          generation: parked.stageJoins[0].conflictGeneration ?? 0, decision: "retry_merge",
        }, authority);
      const integrationsBefore = integrations;
      armed = true;
      const decision = decide();
      await waiting.promise;
      current = false;
      release.resolve();
      expect(await decision).toEqual({ ok: false, reason: "remote-controller-authority-revoked" });
      await h.drainRunWork();
      const unchanged = await h.item(itemId);
      if (kind === "gate") expect(unchanged.stageRuns[0].gate).toMatchObject({ status: "pending" });
      else expect(unchanged.stageJoins[0]).toMatchObject({ status: "conflict", conflict: parked.stageJoins[0].conflict });
      expect(h.children).toHaveLength(1);
      expect(integrations).toBe(integrationsBefore);
    } finally {
      release.resolve();
      await blocker;
      enqueueWrite.mockRestore();
      spy.mockRestore();
    }
  });
});

it("refuses remote start when authority is revoked before the board names the admitted run", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    let current = true;
    const authority = { refreshCurrent: async () => current, isCurrent: () => current };
    const { itemId, remoteProvisional } = await provisionalItem(h, version.templateId, authority);
    let runId: string | undefined;
    const stop = h.board.runs.runChanged.subscribe(id => { runId ??= id; current = false; });
    try {
      const start = h.engine.runItem(itemId, {
        templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) },
        authority, remoteProvisional,
      });
      const result = await Promise.race([start, h.untilSpawned(1, itemId).then(() => ({ status: "child-started" }))]);
      expect(result).toMatchObject({ status: "error", reasonCode: "remote-controller-authority-revoked" });
      expect((await h.item(itemId)).runId).toBeUndefined();
      if (!runId) throw new Error("Run file did not reach the first write");
      const run = await h.runOf(runId);
      if (run) expect(run.settled).toMatchObject({ status: "error" });
      expect(h.children).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

it("refuses a remote start revoked during workspace persistence after the board names its run", async () => {
  const preparing = deferred<void>();
  const release = deferred<void>();
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: board => {
      const runs = boardRunState(board);
      let firstWrite = true;
      return { runs: {
        ...runs,
        async update(...args) {
          if (firstWrite) {
            firstWrite = false;
            preparing.resolve();
            await release.promise;
          }
          return runs.update(...args);
        },
      } };
    },
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    let current = true;
    const authority = { refreshCurrent: async () => current, isCurrent: () => current };
    const { itemId, remoteProvisional } = await provisionalItem(h, version.templateId, authority);
    const start = h.engine.runItem(itemId, {
      templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) },
      authority, remoteProvisional,
    });
    try {
      await preparing.promise;
      expect((await h.item(itemId)).runId).toBeDefined();
      current = false;
      release.resolve();
      const result = await Promise.race([start, h.untilSpawned(1, itemId).then(() => ({ status: "child-started" }))]);
      expect(result).toMatchObject({ status: "error", reasonCode: "remote-controller-authority-revoked" });
      expect(h.children).toHaveLength(0);
      expect((await h.item(itemId)).runStatus).toBe("error");
    } finally {
      release.resolve();
    }
  });
});

it("refuses revocation after the board enters executing and before the scheduler commits the start", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    let current = true;
    const authority = { refreshCurrent: async () => current, isCurrent: () => current };
    const { itemId, remoteProvisional } = await provisionalItem(h, version.templateId, authority);
    const entered = deferred<void>();
    const release = deferred<void>();
    const setStatus = h.board.setRunStatus.bind(h.board);
    const spy = vi.spyOn(h.board, "setRunStatus").mockImplementation(async (...args) => {
      const written = await setStatus(...args);
      if (args[1] === "executing") {
        entered.resolve();
        await release.promise;
      }
      return written;
    });
    const start = h.engine.runItem(itemId, {
      templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) },
      authority, remoteProvisional,
    });
    try {
      await entered.promise;
      expect((await h.item(itemId)).runStatus).toBe("executing");
      current = false;
      release.resolve();
      const result = await Promise.race([start, h.untilSpawned(1, itemId).then(() => ({ status: "child-started" }))]);
      expect(result).toMatchObject({ status: "error", reasonCode: "remote-controller-authority-revoked" });
      expect(h.children).toHaveLength(0);
      expect((await h.item(itemId)).runStatus).toBe("error");
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });
});
