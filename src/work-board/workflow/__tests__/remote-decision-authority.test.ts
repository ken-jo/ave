import { expect, it } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { boardRunState } from "../run-state.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

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
  const authority = {
    refreshCurrent: async () => failure === "commit" || current,
    isCurrent: () => failure === "refresh" || current,
  };
  async function waitAtWrite() {
    if (!armed) return;
    armed = false;
    waiting.resolve();
    await release.promise;
  }
  const h = await stageRunHarness({
    observeRunWork: true,
    integrate: () => ({ ok: false, conflict: { conflictHash: "c".repeat(64), reason: "merge-conflict", files: [] } }),
    wiring: board => {
      const runs = boardRunState(board);
      return { runs: {
        ...runs,
        begin: async (...args) => { if (kind === "start") await waitAtWrite(); return runs.begin(...args); },
        update: async (...args) => { if (kind !== "start") await waitAtWrite(); return runs.update(...args); },
      } };
    },
  });
  await h.runThenEnd(async () => {
    try {
      const version = await h.confirm(kind === "join" ? [autoStageOf("a")] : [stageOf("a")]);
      const itemId = await h.addItem(version);
      if (kind === "start") {
        armed = true;
        const start = h.engine.runItem(itemId, { templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) }, authority });
        await waiting.promise;
        current = false;
        release.resolve();
        const result = await Promise.race([start, h.untilSpawned(1, itemId).then(() => ({ status: "child-started" }))]);
        expect(result).toMatchObject({ status: "error", reasonCode: "remote-controller-authority-revoked" });
        expect((await h.item(itemId)).runId).toBeUndefined();
        expect(h.children).toHaveLength(0);
        return;
      }

      const start = h.start(itemId, h.local(version));
      (await h.untilLive(1, itemId))[0].finish();
      await start;
      const parked = await h.item(itemId);
      const runId = parked.runId ?? "";
      const decide = kind === "gate"
        ? () => h.engine.decideStageGate(itemId, {
          runId, stageId: "a", attempt: 1, resultHash: parked.stageRuns[0].resultHash ?? "", decision: "approve",
        }, authority)
        : () => h.engine.decideStageJoin(itemId, {
          runId, joinId: parked.stageJoins[0].joinId, conflictHash: parked.stageJoins[0].conflict?.conflictHash ?? "",
          generation: parked.stageJoins[0].conflictGeneration ?? 0, decision: "retry_merge",
        }, authority);
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
    } finally {
      release.resolve();
    }
  });
});

it("refuses remote start when authority is revoked before the board names the admitted run", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    const itemId = await h.addItem(version);
    let current = true;
    let runId: string | undefined;
    const stop = h.board.runs.runChanged.subscribe(id => { runId ??= id; current = false; });
    try {
      const start = h.engine.runItem(itemId, {
        templateSource: { kind: "tailnet-create-and-run", pin: h.pinOf(version) },
        authority: { refreshCurrent: async () => current, isCurrent: () => current },
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
