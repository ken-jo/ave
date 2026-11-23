import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import type { RunRecord } from "../shipped-shapes.js";
import { boardRunState } from "../run-state.js";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

it.each(["human", "auto"] as const)(
  "recovers a pending %s stage seal before its parallel step integrates",
  async gate => {
    let restarted = false;
    let crashReached = false;
    const crashed = deferred<void>();
    let receiptRoot = "";
    const sealWrites: string[] = [];
    const missingAtIntegration: string[][] = [];
    const receipt = (stageId: string) =>
      join(receiptRoot, `sealed-${stageId}-1`);

    const h = await stageRunHarness({
      workspace: {
        seal: async (_run, stageId) => {
          const path = receipt(stageId);
          if (!existsSync(path)) {
            const fd = openSync(path, "wx", 0o600);
            try {
              writeFileSync(fd, `immutable result of ${stageId}`);
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
            sealWrites.push(stageId);
          }
          return { ok: true };
        },
        integrate: async (_run, _joinId, stageIds) => {
          const missing = stageIds.filter(id => !existsSync(receipt(id)));
          missingAtIntegration.push(missing);
          if (missing.length > 0) {
            return {
              ok: false,
              conflict: {
                conflictHash: "f".repeat(64),
                reason: "identity-missing",
                files: [],
              },
            };
          }
          return { ok: true };
        },
      },
      wiring: store => {
        const records = boardRunState(store);
        return {
          runs: {
            ...records,
            update: async (itemId, runId, mutate, removedAs) => {
              let passedA = false;
              const stored = await records.update(
                itemId,
                runId,
                current => {
                  const next = mutate(current);
                  const run = next && "run" in next ? next.run : next;
                  passedA =
                    current.stageRuns.find(stage => stage.stageId === "a")
                      ?.status !== "passed" &&
                    run?.stageRuns.find(stage => stage.stageId === "a")
                      ?.status === "passed";
                  return next;
                },
                removedAs,
              );
              if (stored.ok && passedA && !restarted) {
                crashReached = true;
                crashed.resolve();
                return new Promise<never>(() => undefined);
              }
              return stored;
            },
          },
        };
      },
    });
    receiptRoot = h.dir;

    try {
      const version = await h.confirm([
        gate === "auto" ? autoStageOf("a") : stageOf("a"),
        stageOf("b"),
      ]);
      const id = await h.addItem(version);
      void h.start(id, h.local(version)).catch(() => undefined);
      const children = await h.untilLive(2);
      const linked = await h.until(
        id,
        item => item.stageRuns.every(stage => stage.childSessionId !== undefined),
      );
      const childFor = (stageId: string) =>
        children.find(
          child =>
            child.sessionId ===
            linked.stageRuns.find(stage => stage.stageId === stageId)
              ?.childSessionId,
        );
      const a = childFor("a");
      const b = childFor("b");
      if (!a || !b) throw new Error("stage children were not linked");

      b.finish();
      await h.untilStage(id, "b", "awaiting_gate");
      a.finish();
      if (gate === "human") {
        await h.untilStage(id, "a", "awaiting_gate");
        void h.decide(id, "a", "approve").catch(() => undefined);
      }
      await crashed.promise;
      expect(crashReached).toBe(true);

      const disk = JSON.parse(
        readFileSync(join(h.dir, "workflow-runs.json"), "utf8"),
      ) as { runs: RunRecord[] };
      expect(disk.runs[0].stageRuns).toMatchObject([
        { stageId: "a", status: "passed" },
        { stageId: "b", status: "awaiting_gate" },
      ]);
      expect(disk.runs[0].stageJoins ?? []).toEqual([]);
      expect(sealWrites).toEqual([]);

      restarted = true;
      h.makeEngine();
      await h.engine.adoptParkedTemplateRuns();
      expect((await h.stageRun(id, "a")).status).toBe("passed");
      expect(await h.decide(id, "b", "approve")).toMatchObject({ ok: true });

      const recovered = await h.until(
        id,
        item =>
          item.stageJoins[0]?.status === "integrated" ||
          item.stageJoins[0]?.status === "conflict",
      );
      expect(missingAtIntegration).toEqual([[]]);
      expect(recovered.stageJoins[0].status).toBe("integrated");
      await h.until(id, item => item.runStatus === "completed");
      expect([...sealWrites].sort()).toEqual(["a", "b"]);
      expect(h.children).toHaveLength(2);

      h.makeEngine();
      await h.engine.adoptParkedTemplateRuns();
      expect([...sealWrites].sort()).toEqual(["a", "b"]);
      expect(missingAtIntegration).toEqual([[]]);
    } finally {
      vi.restoreAllMocks();
      await h.cleanup();
    }
  },
);
