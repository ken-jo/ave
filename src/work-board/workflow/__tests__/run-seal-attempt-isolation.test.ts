import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it("a retried stage seals independently without retaining its old commit", async () => {
  const oldCommit = "a".repeat(40);
  const newCommit = "b".repeat(40);
  const seals: string[] = [];
  let integrations = 0;

  const h = await stageRunHarness({
    workspace: {
      seal: async (_run, stageId) => {
        seals.push(stageId);
        const calls = seals.filter(id => id === stageId).length;
        return {
          ok: true,
          sealCommit:
            stageId === "a" && calls === 1 ? oldCommit : newCommit,
        };
      },
      integrate: async () => {
        integrations += 1;
        return { ok: true };
      },
    },
  });

  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version));
    const children = await h.untilLive(2);

    for (const child of children) child.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    await h.untilStage(id, "b", "awaiting_gate");
    await started;

    expect(await h.decide(id, "a", "approve")).toMatchObject({
      ok: true,
    });
    const first = await h.stageRun(id, "a");
    expect(first).toMatchObject({
      attempt: 1,
      status: "passed",
      workspace: { sealCommit: oldCommit },
    });
    expect((await h.stageRun(id, "b")).workspace?.sealCommit)
      .toBeUndefined();
    expect((await h.item(id)).stageJoins).toEqual([]);

    if (!first.workspace) throw new Error("stage workspace was not stored");
    rmSync(first.workspace.root, { recursive: true, force: true });

    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    await h.untilStage(id, "a", "failed");
    expect(await h.stageRun(id, "a")).toMatchObject({
      attempt: 1,
      failure: "workspace-lost",
    });

    const runId = (await h.item(id)).runId;
    if (!runId) throw new Error("run identity was not stored");

    expect(
      await h.engine.retryStage(id, { runId, stageId: "a" }),
    ).toMatchObject({ ok: true });

    const replacement = (await h.untilSpawned(3))[2];
    await h.until(
      id,
      item =>
        item.stageRuns.find(stage => stage.stageId === "a")
          ?.childSessionId === replacement.sessionId,
    );

    const running = await h.stageRun(id, "a");
    expect(running).toMatchObject({ attempt: 2, status: "running" });
    expect(running.workspace?.root).not.toBe(first.workspace.root);
    expect(running.workspace?.sealCommit).toBeUndefined();

    replacement.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    expect(await h.decide(id, "a", "approve")).toMatchObject({
      ok: true,
    });
    expect(await h.stageRun(id, "a")).toMatchObject({
      attempt: 2,
      status: "passed",
      workspace: { sealCommit: newCommit },
    });
    expect((await h.stageRun(id, "b")).workspace?.sealCommit)
      .toBeUndefined();

    expect(await h.decide(id, "b", "approve")).toMatchObject({
      ok: true,
    });
    await h.until(id, item => item.runStatus === "completed");
    await h.engine.adoptParkedTemplateRuns();

    expect(seals).toEqual(["a", "a", "b"]);
    expect(integrations).toBe(1);
    expect(h.children).toHaveLength(3);
  } finally {
    for (const child of h.live()) child.finish({ ok: false });
    await h.cleanup();
  }
});
