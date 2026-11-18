import { expect, it, vi } from "vitest";
import { boardRunState } from "../run-state.js";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["row-lost", "board-unread", "throw", "memory-only"] as const)("a failed seal stays blocked while its outcome write is held by %s", async mode => {
  let blocked = true;
  let failedSeal = false;
  let failureWrites = 0;
  let heldWrites = 0;
  let seals = 0;
  let integrations = 0;
  const h = await stageRunHarness({
    wiring: store => {
      const records = boardRunState(store);
      return { runs: {
        ...records,
        update: async (...args) => {
          const current = await records.get(args[0], args[1]);
          const next = current ? args[2](current) : null;
          const record = next && "run" in next ? next.run : next;
          if (blocked && failedSeal && record?.stageRuns.some(stage => stage.stageId === "a" && stage.status === "failed")) {
            failureWrites += 1;
            if (mode === "throw") throw new Error("outcome write unavailable");
            return { ok: false, reason: mode === "row-lost" ? "row-lost" : "board-unread" };
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
    await h.until(id, item => item.stageRuns[0]?.childSessionId === child.sessionId);
    child.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(heldWrites).toBe(1));
    const before = failureWrites;
    await vi.waitFor(async () => {
      await h.engine.adoptParkedTemplateRuns();
      expect(failureWrites).toBeGreaterThan(before);
    });
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
    await vi.waitFor(async () => {
      await h.engine.adoptParkedTemplateRuns();
      expect((await h.stageRun(id, "a")).status).toBe("failed");
    });
    await started;
    expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 1, failure: "error", gate: { status: "approved" } });
    expect((await h.item(id)).stageJoins).toEqual([]);
    expect(seals).toBe(1);
    expect(integrations).toBe(0);
    expect(await h.engine.retryStage(id, { runId, stageId: "a" })).toMatchObject({ ok: true });
    const replacement = (await h.untilSpawned(2))[1];
    await h.until(id, item => item.stageRuns[0]?.childSessionId === replacement.sessionId);
    replacement.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    expect((await h.stageRun(id, "a")).attempt).toBe(2);
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    await h.until(id, item => item.runStatus === "completed");
    expect(seals).toBe(2);
    expect(integrations).toBe(1);
    expect(await boardRunState(h.board).heldEvents({ itemId: id, runId })).toEqual([]);
  } finally {
    blocked = false;
    for (const child of h.live()) child.finish({ ok: false });
    await started?.catch(() => undefined);
    await h.cleanup();
  }
});
