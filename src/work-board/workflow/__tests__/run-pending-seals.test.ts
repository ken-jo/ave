import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { boardRunState } from "../run-state.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["human", "auto"] as const)("a pending %s seal recovers without restarting on a read or decision", async gate => {
  for (const recovery of ["read", "decision"] as const) {
    let withheld = false;
    const h = await stageRunHarness({
      wiring: store => {
        const records = boardRunState(store);
        return { runs: { ...records, update: async (...args) => {
          const stored = await records.update(...args);
          if (stored.ok && !withheld && stored.run.stageRuns.some(stage => stage.stageId === "a" && stage.status === "passed")) {
            withheld = true;
            return { ok: false, reason: "board-unread" };
          }
          return stored;
        } } };
      },
    });
    try {
      const engine = h.engine;
      const version = await h.confirm([gate === "auto" ? autoStageOf("a") : stageOf("a"), stageOf("b")]);
      const id = await h.addItem(version);
      void h.start(id, h.local(version));
      const children = await h.untilLive(2);
      const linked = await h.until(id, item => item.stageRuns.every(stage => stage.childSessionId !== undefined));
      const childFor = (stageId: string) => children.find(child => child.sessionId === linked.stageRuns.find(stage => stage.stageId === stageId)?.childSessionId);
      const a = childFor("a");
      const b = childFor("b");
      if (!a || !b) throw new Error("stage children were not linked");
      a.finish();
      if (gate === "human") {
        await h.untilStage(id, "a", "awaiting_gate");
        expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: false });
      }
      await vi.waitFor(() => expect(withheld).toBe(true));
      expect((await h.stageRun(id, "a")).status).toBe("passed");
      expect((await h.item(id)).stageJoins).toEqual([]);
      expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(0);
      if (recovery === "read") {
        await engine.adoptParkedTemplateRuns();
      } else expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: false });
      await vi.waitFor(() => expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(1));
      b.finish();
      await h.untilStage(id, "b", "awaiting_gate");
      expect(await h.decide(id, "b", "approve")).toMatchObject({ ok: true });
      await h.until(id, item => item.runStatus === "completed");
      await engine.adoptParkedTemplateRuns();
      expect(h.engine).toBe(engine);
      expect(h.workspaceCalls.filter(call => call === "seal:a")).toHaveLength(1);
      expect(h.workspaceCalls.filter(call => call === "seal:b")).toHaveLength(1);
      expect(h.workspaceCalls.filter(call => call.startsWith("integrate:"))).toHaveLength(1);
    } finally { await h.cleanup(); }
  }
});

it("an integration seals every member first and never collects a failed seal", async () => {
  let withheld = false;
  let failing = true;
  let sealedB = false;
  let integrations = 0;
  const seals: string[] = [];
  const h = await stageRunHarness({
    wiring: store => {
      const records = boardRunState(store);
      return { runs: {
        ...records,
        classes: () => withheld ? Promise.resolve("template-runs-pending-review") : records.classes(),
        update: async (...args) => {
          const stored = await records.update(...args);
          if (stored.ok && !withheld && stored.run.stageRuns.some(stage => stage.stageId === "a" && stage.status === "passed")) {
            withheld = true;
            return { ok: false, reason: "board-unread" };
          }
          return stored;
        },
      } };
    },
    workspace: {
      seal: async (_run, stageId) => {
        seals.push(stageId);
        if (stageId === "a" && failing) return { ok: false, code: "identity-missing" };
        sealedB = true;
        return { ok: true };
      },
      integrate: async () => { integrations += 1; return { ok: true }; },
    },
  });
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const children = await h.untilLive(2);
    const linked = await h.until(id, item => item.stageRuns.every(stage => stage.childSessionId !== undefined));
    const a = children.find(child => child.sessionId === linked.stageRuns.find(stage => stage.stageId === "a")?.childSessionId);
    const b = children.find(child => child.sessionId === linked.stageRuns.find(stage => stage.stageId === "b")?.childSessionId);
    if (!a || !b) throw new Error("stage children were not linked");
    b.finish();
    await h.untilStage(id, "b", "awaiting_gate");
    a.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: false });
    expect(seals).toEqual([]);
    expect(await h.decide(id, "b", "approve")).toMatchObject({ ok: true });
    await h.untilStage(id, "a", "failed");
    expect(sealedB).toBe(true);
    expect(seals).toEqual(["b", "a"]);
    expect(integrations).toBe(0);
    expect((await h.stageRun(id, "a")).gate).toMatchObject({ status: "approved" });
    expect((await h.stageRun(id, "b")).status).toBe("passed");
    expect((await h.item(id)).stageJoins).toEqual([]);
    failing = false;
    const runId = (await h.item(id)).runId ?? "";
    expect(await h.engine.retryStage(id, { runId, stageId: "a" })).toMatchObject({ ok: true });
    (await h.untilSpawned(3))[2].finish();
    await h.untilStage(id, "a", "awaiting_gate");
    expect((await h.stageRun(id, "a")).attempt).toBe(2);
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    await h.until(id, item => item.runStatus === "completed");
    expect(seals).toEqual(["b", "a", "a"]);
    expect(integrations).toBe(1);
  } finally { await h.cleanup(); }
});

it("reopening a sealed partial step returns the provider receipt without another freeze", async () => {
  let receiptRoot = "";
  const calls: string[] = [];
  const freezes: string[] = [];
  const h = await stageRunHarness({ workspace: { seal: async (_run, stageId) => {
    calls.push(stageId);
    const receipt = join(receiptRoot, `${stageId}-1.seal`);
    if (!existsSync(receipt)) {
      writeFileSync(receipt, "immutable result", { flag: "wx" });
      freezes.push(stageId);
    }
    return { ok: true, sealCommit: "a".repeat(40) };
  } } });
  receiptRoot = h.dir;
  try {
    const version = await h.confirm([autoStageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const children = await h.untilLive(2);
    const linked = await h.until(id, item => item.stageRuns.every(stage => stage.childSessionId !== undefined));
    for (const child of children) child.finish();
    await h.untilStage(id, "b", "awaiting_gate");
    await h.until(id, item => item.stageRuns.find(stage => stage.stageId === "a")?.workspace?.sealCommit !== undefined);
    expect((await h.item(id)).stageJoins).toEqual([]);
    expect(calls).toEqual(["a"]);
    h.makeEngine();
    await h.engine.adoptParkedTemplateRuns();
    await vi.waitFor(() => expect(calls).toEqual(["a", "a"]));
    expect(freezes).toEqual(["a"]);
    expect((await h.stageRun(id, "a")).gate).toMatchObject({ passed: true });
    expect(await h.decide(id, "b", "approve")).toMatchObject({ ok: true });
    await h.until(id, item => item.runStatus === "completed");
    await h.engine.adoptParkedTemplateRuns();
    expect(calls).toEqual(["a", "a", "b"]);
    expect(freezes).toEqual(["a", "b"]);
    expect(h.children).toHaveLength(linked.stageRuns.length);
  } finally { await h.cleanup(); }
});
