import { expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { deferred } from "../../../__tests__/support/deferred.js";
import type { WorkItemStageRun } from "../../../shared/workflow-template-types.js";
import { boardRunState } from "../run-state.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

const isFailedFirstAttempt = (stage: WorkItemStageRun) => stage.stageId === "a" && stage.attempt === 1 && stage.status === "failed";

it.each([
  ["row-lost", "stored"],
  ["board-unread", "stored"],
  ["throw", "stored"],
  ["memory-only", "stored"],
  ["row-lost", "skipped replay"],
  ["row-lost", "refused storage"],
] as const)("a failed seal held by %s checks recovery with %s", async (mode, recovery) => {
  const replayReachedWrite = deferred<void>();
  const releaseWrite = deferred<void>();
  let replayResult: Awaited<ReturnType<ReturnType<typeof boardRunState>["update"]>> | undefined;
  let skipReplay = false;
  let blocked = true;
  let failedSeal = false;
  let failureWrites = 0;
  let heldWrites = 0;
  let seals = 0;
  let integrations = 0;
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: store => {
      const records = boardRunState(store);
      return { runs: {
        ...records,
        get: (...args) => skipReplay ? Promise.resolve(null) : records.get(...args),
        update: async (...args) => {
          if (failedSeal) {
            const current = await records.get(args[0], args[1]);
            const next = current ? args[2](current) : null;
            const record = next && "run" in next ? next.run : next;
            if (record?.stageRuns.some(isFailedFirstAttempt)) {
              if (blocked) {
                failureWrites += 1;
                if (mode === "throw") throw new Error("outcome write unavailable");
                return { ok: false, reason: mode === "row-lost" ? "row-lost" : "board-unread" };
              }
              replayReachedWrite.resolve();
              await releaseWrite.promise;
              replayResult = recovery === "refused storage" ? { ok: false, reason: "row-lost" } : await records.update(...args);
              return replayResult;
            }
          }
          return records.update(...args);
        },
        holdEvent: async event => {
          heldWrites += 1;
          return mode === "memory-only" ? false : records.holdEvent(event);
        },
      } };
    },
    workspace: {
      seal: async () => {
        seals += 1;
        if (seals === 1) {
          failedSeal = true;
          return { ok: false, code: "identity-missing" };
        }
        return { ok: true };
      },
      integrate: async () => { integrations += 1; return { ok: true }; },
    },
  });
  let started: Promise<unknown> | undefined;
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    started = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).childSessionId).toBe(child.sessionId);
    child.finish();
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).status).toBe("awaiting_gate");
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    await h.drainRunWork();
    expect(heldWrites).toBe(1);
    const before = failureWrites;
    await h.engine.adoptParkedTemplateRuns();
    await h.drainRunWork();
    expect(failureWrites).toBeGreaterThan(before);
    const waiting = await h.item(id);
    expect(waiting.stageRuns[0]).toMatchObject({ attempt: 1, status: "passed", gate: { status: "approved" } });
    expect(waiting.record?.settled).toBeUndefined();
    expect(waiting.stageJoins.map(join => join.status)).toEqual(["integrating"]);
    expect(seals).toBe(1);
    expect(integrations).toBe(0);
    const runId = waiting.runId ?? "";
    const held = await boardRunState(h.board).heldEvents({ itemId: id, runId });
    expect(held.map(event => ({ stage: event.stage, attempt: event.attempt, kind: event.kind }))).toEqual(mode === "memory-only" ? [] : [{ stage: "a", attempt: 1, kind: "seal_failed" }]);

    blocked = false;
    skipReplay = recovery === "skipped replay";
    await h.engine.adoptParkedTemplateRuns();
    const drain = h.drainRunWork();
    async function checkReplay() {
      try {
        const first = await Promise.race([
          replayReachedWrite.promise.then(() => "writer"),
          drain.then(() => "drain"),
        ]);
        expect(first, "seal replay ended before reaching the writer").toBe("writer");
        expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 1, status: "passed" });
      } finally {
        releaseWrite.resolve();
        await drain;
      }
      expect(replayResult, "seal replay did not store the failed outcome").toMatchObject({
        ok: true, run: { stageRuns: expect.arrayContaining([expect.objectContaining({ stageId: "a", attempt: 1, status: "failed" })]) },
      });
    }
    const replay = checkReplay();
    if (recovery !== "stored") {
      const failure = await Promise.race([
        replay.then(() => "replay succeeded", (error: Error) => error.message),
        drain.then(() => setImmediate("replay check stayed pending after drain completion")),
      ]);
      expect(failure).toContain(recovery === "skipped replay"
        ? "seal replay ended before reaching the writer" : "seal replay did not store the failed outcome");
      return;
    }
    await replay;
    await started;
    expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 1, status: "failed", failure: "error", gate: { status: "approved" } });
    expect((await h.item(id)).stageJoins).toEqual([]);
    expect(seals).toBe(1);
    expect(integrations).toBe(0);
    expect(await h.engine.retryStage(id, { runId, stageId: "a", attempt: 1 })).toMatchObject({ ok: true });
    const replacement = (await h.untilSpawned(2))[1];
    await h.drainRunWork();
    expect((await h.stageRun(id, "a")).childSessionId).toBe(replacement.sessionId);
    replacement.finish();
    await h.drainRunWork();
    expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 2, status: "awaiting_gate" });
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    await h.drainRunWork();
    expect((await h.item(id)).runStatus).toBe("completed");
    expect(seals).toBe(2);
    expect(integrations).toBe(1);
    expect(await boardRunState(h.board).heldEvents({ itemId: id, runId })).toEqual([]);
  } finally {
    blocked = false;
    skipReplay = false;
    releaseWrite.resolve();
    for (const child of h.live()) child.finish({ ok: false });
    await started?.catch(() => undefined);
    await h.drainRunWork();
    await h.cleanup();
  }
});
