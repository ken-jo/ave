import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunStore } from "../../../main/workflow-run-store.js";
import type { WorkflowRunRecord } from "../../../shared/workflow-template-types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "run-settled-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const pin = { templateId: "template-1", version: 1, graphHash: "b".repeat(64) };
const run: WorkflowRunRecord = {
  runId: "run-1", itemId: 1, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z",
  stageRuns: [{ stageId: "plan", attempt: 1, status: "failed", failure: "error" }],
};

it("the run file keeps how a run ended, and refuses an unknown ending", async () => {
  const store = new WorkflowRunStore(join(dir, "workflow-runs.json"));
  await store.put(run);
  const settled = { status: "cancelled" as const, at: "2026-01-02T00:00:00.000Z" };
  expect(await store.update("run-1", current => ({ ...current, settled }))).toMatchObject({ status: "stored", run: { settled } });
  expect(await store.get("run-1")).toMatchObject({ status: "found", run: { settled } });
  for (const bad of [{ status: "executing", at: settled.at }, { status: "cancelled" }, { ...settled, extra: 1 }]) {
    await expect(store.update("run-1", current => ({ ...current, settled: bad as never }))).rejects.toMatchObject({ code: "invalid-template-run" });
  }
});
