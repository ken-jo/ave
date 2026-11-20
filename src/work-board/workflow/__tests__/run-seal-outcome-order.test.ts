import { expect, it, vi } from "vitest";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

function latch() {
  let release: () => void = () => undefined;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  return { ready, release: () => release() };
}

it.each(["human", "auto"] as const)(
  "a reader queued during a failed %s seal cannot collect that attempt",
  async gate => {
    const pending = latch();
    let entered = false;
    let seals = 0;
    let integrations = 0;

    const h = await stageRunHarness({
      workspace: {
        seal: async () => {
          seals += 1;
          if (seals === 1) {
            entered = true;
            await pending.ready;
            return { ok: false, code: "identity-missing" };
          }
          return { ok: true };
        },
        integrate: async () => {
          integrations += 1;
          return { ok: true };
        },
      },
    });

    let started: Promise<unknown> | undefined;
    let approved: Promise<unknown> | undefined;

    try {
      const version = await h.confirm([
        gate === "auto" ? autoStageOf("a") : stageOf("a"),
      ]);
      const id = await h.addItem(version);
      started = h.start(id, h.local(version));
      const [child] = await h.untilLive(1);
      await h.until(
        id,
        item => item.stageRuns[0]?.childSessionId === child.sessionId,
      );

      child.finish();
      if (gate === "human") {
        await h.untilStage(id, "a", "awaiting_gate");
        approved = h.decide(id, "a", "approve");
      }

      await vi.waitFor(() => expect(entered).toBe(true));

      // This read queues recovery before the pending failure is posted.
      await h.engine.adoptParkedTemplateRuns();
      pending.release();

      await approved;
      await started;
      await h.untilStage(id, "a", "failed");

      const current = await h.item(id);
      expect(integrations).toBe(0);
      expect(seals).toBe(1);
      expect(current.stageJoins).toEqual([]);
      expect(current.record?.settled).toBeUndefined();

      const stage = await h.stageRun(id, "a");
      expect(stage).toMatchObject({
        attempt: 1,
        status: "failed",
        failure: "error",
      });
      expect(stage.gate).toMatchObject(
        gate === "human"
          ? { type: "human", status: "approved" }
          : { type: "auto", passed: true },
      );
    } finally {
      pending.release();
      for (const child of h.live()) child.finish({ ok: false });
      await approved?.catch(() => undefined);
      await started?.catch(() => undefined);
      await h.cleanup();
    }
  },
);

it("a reader queued during a successful seal reuses its attempt cache", async () => {
  const pending = latch();
  let entered = false;
  let seals = 0;
  let integrations = 0;

  const h = await stageRunHarness({
    workspace: {
      seal: async () => {
        seals += 1;
        entered = true;
        await pending.ready;
        return { ok: true };
      },
      integrate: async () => {
        integrations += 1;
        return { ok: true };
      },
    },
  });

  let started: Promise<unknown> | undefined;
  let approved: Promise<unknown> | undefined;

  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    started = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    child.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    await started;

    approved = h.decide(id, "a", "approve");
    await vi.waitFor(() => expect(entered).toBe(true));
    await h.engine.adoptParkedTemplateRuns();
    pending.release();

    await approved;
    await h.until(id, item => item.runStatus === "completed");
    await h.engine.adoptParkedTemplateRuns();

    expect(seals).toBe(1);
    expect(integrations).toBe(1);
    expect((await h.item(id)).stageJoins[0]).toMatchObject({
      status: "integrated",
    });
  } finally {
    pending.release();
    for (const child of h.live()) child.finish({ ok: false });
    await approved?.catch(() => undefined);
    await started?.catch(() => undefined);
    await h.cleanup();
  }
});
