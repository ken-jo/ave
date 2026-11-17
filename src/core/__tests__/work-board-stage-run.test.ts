/** A template run end to end over a real board and template store: which stages spawn, from which version, under which authority. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { isAwaitingStageReview } from "../../work-board/workflow/run-state.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { WorkflowTemplateError } from "../../work-board/template-graph.js";
import { RUN_FILE_REFUSALS } from "../../work-board/workflow/stage-run-engine.js";
import { WORKSPACE_REFUSALS } from "../../work-board/workflow/stage-workspace.js";
import type { RunAuthorityVerdict } from "../../work-board/workflow/run-authority.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
async function withHarness(run: (h: Harness) => Promise<void>, opts: Parameters<typeof stageRunHarness>[0] = {}): Promise<void> {
  const h = await stageRunHarness(opts);
  try {
    await run(h);
  } finally {
    await h.cleanup();
  }
}

const auto = autoStageOf;
const A = "/projects/a";
const B = "/projects/b";

it("spawns only the pinned version's stages with the stage's tool scope", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"], toolScope: "all" })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  expect(a.input.title).toContain("Stage a");
  expect(a.input.toolScope).toEqual({ kind: "exactly", names: ["read_file", "grep_files", "sample_lookup"] });
  expect(a.input.profileMode).toBe("plan");
  a.finish();
  await h.untilStage(id, "a", "awaiting_gate");
  expect(h.children).toHaveLength(1);
  expect(await h.decide(id, "a", "approve")).toEqual({ ok: true, status: "approved" });
  const [b] = await h.untilLive(1);
  expect(b.input.title).toContain("Stage b");
  expect(b.input.toolScope.kind).toBe("parent-all");
  expect(b.input.profileMode).toBe("execute");
  expect(b.input.instructions).toContain("output of child-1");
  b.finish();
  await h.untilStage(id, "b", "awaiting_gate");
  await h.decide(id, "b", "approve");
  const done = await h.until(id, item => item.runStatus === "completed");
  expect(done.output).toBe("output of child-2");
  expect(done.planApproval).toBeUndefined();
  expect(h.children).toHaveLength(2);
  expect(await run).toMatchObject({ status: "awaiting_approval" });
}));

it("a run whose template gained v2 with the same scope mid-run still spawns v1 stages", () => withHarness(async (h) => {
  const v1 = await h.confirm([auto("a"), auto("b", { inputs: ["a"] })]);
  const id = await h.addItem(v1);
  const run = h.start(id, h.local(v1));
  const [a] = await h.untilLive(1);
  const v2 = await h.confirm([auto("a", { goal: "v2 a" }), auto("c", { inputs: ["a"], name: "Stage c of v2", goal: "v2 c" })], { id: v1.templateId });
  expect(v2.version).toBe(2);
  expect((await h.templates.get(v1.templateId)).template.currentVersion).toBe(2);
  a.finish();
  const [b] = await h.untilLive(1);
  expect(b.input.title).toContain("Stage b");
  expect(b.input.instructions).toContain("Do b");
  expect(b.input.instructions).not.toContain("v2");
  b.finish();
  expect(await run).toMatchObject({ status: "completed" });
  const item = await h.item(id);
  expect(item.record?.pin.version).toBe(1);
  expect(item.stageRuns?.map(stage => stage.stageId)).toEqual(["a", "b"]);
}));

it("refuses to start when the pinned version is missing", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const result = await h.start(id, { kind: "local-create-and-run", pin: { ...h.pinOf(version), version: 2 } });
  expect(result).toMatchObject({ status: "error", reasonCode: "version-missing" });
  expect((await h.item(id)).runId).toBeUndefined();
  expect(h.children).toHaveLength(0);
  expect(h.workspaceCalls).toEqual([]);
}));

it("refuses to start when the Create and run tuple differs from the stored version or hash", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const otherHash = await h.start(id, { kind: "local-create-and-run", pin: { ...h.pinOf(version), graphHash: "a".repeat(64) } });
  expect(otherHash).toMatchObject({ status: "error", reasonCode: "graph-mismatch" });
  const otherVersion = await h.start(id, { kind: "local-create-and-run", pin: { ...h.pinOf(version), version: 7 } });
  expect(otherVersion).toMatchObject({ status: "error", reasonCode: "version-missing" });
  const item = await h.item(id);
  expect(item.runId).toBeUndefined();
  expect(existsSync(join(h.dir, "workflow-runs.json"))).toBe(false);
  expect(h.children).toHaveLength(0);
  // The refused starts left the item free to run.
  const run = h.start(id, h.local(version));
  await h.untilLive(1);
  h.engine.cancelRun(id);
  expect(await run).toMatchObject({ status: "cancelled" });
}));

it("refuses Create and run for a version that is not current, and for an archived template", () => withHarness(async (h) => {
  const v1 = await h.confirm([stageOf("a")]);
  const v2 = await h.confirm([stageOf("a", { goal: "again" })], { id: v1.templateId });
  const id = await h.addItem(v1);
  expect(await h.start(id, h.local(v1))).toMatchObject({ status: "error", reasonCode: "not-current-version" });
  await h.templates.archive(v1.templateId);
  expect(await h.start(id, h.local(v2))).toMatchObject({ status: "error", reasonCode: "template-archived" });
  expect((await h.item(id)).runId).toBeUndefined();
  expect(h.children).toHaveLength(0);
}));

it("a schedule source starts its attachment pin while a newer version is current", () => withHarness(async (h) => {
  const v1 = await h.confirm([auto("a")]);
  const attachment = await h.attach(v1);
  await h.confirm([auto("a", { goal: "v2 a" })], { id: v1.templateId });
  const id = await h.addItem(v1);
  const run = h.start(id, attachment.source);
  const [a] = await h.untilLive(1);
  expect(a.input.instructions).toContain("Do a");
  expect(a.input.unattendedStage).toMatchObject({ stageId: "a" });
  a.finish();
  expect(await run).toMatchObject({ status: "completed" });
  expect((await h.item(id)).record?.pin.version).toBe(1);
}));

it("a schedule source with a detached attachment, or a version that is not all read-only, starts nothing", async () => {
  await withHarness(async (h) => {
    const version = await h.confirm([auto("a")]);
    const attachment = await h.attach(version);
    await h.detach(attachment.id);
    const id = await h.addItem(version);
    expect(await h.start(id, attachment.source)).toMatchObject({ status: "error", reasonCode: "attachment-detached" });
    expect(await h.start(id, { ...attachment.source, attachmentId: "missing" } as typeof attachment.source)).toMatchObject({ status: "error", reasonCode: "attachment-missing" });
    expect((await h.item(id)).runId).toBeUndefined();
    expect(h.children).toHaveLength(0);
  });
  // The store attaches only an all-read-only version, so the interim limit is reached through the qualification the engine asks.
  await withHarness(async (h) => {
    const version = await h.confirm([auto("a")]);
    const attachment = await h.attach(version);
    const id = await h.addItem(version);
    expect(await h.start(id, attachment.source)).toMatchObject({ status: "error", reasonCode: "unattended-not-read-only" });
    expect((await h.item(id)).runId).toBeUndefined();
    expect(h.children).toHaveLength(0);
  }, { workflow: { unattendedAllowed: () => ({ ok: false, code: "unattended-not-read-only" }) } });
});

it("a v1 schedule approved for project A is refused scope-changed after v2 moves the template to project B, and nothing is seeded from or read in B", () => withHarness(async (h) => {
  const v1 = await h.confirm([auto("a")], { scope: { kind: "project", projectRoot: A } });
  const attachment = await h.attach(v1, { kind: "project", projectRoot: A });
  await h.confirm([auto("a", { goal: "v2 a" })], { id: v1.templateId, scope: { kind: "project", projectRoot: B } });
  for (const root of [A, B]) {
    const id = await h.addItem(v1, root);
    expect(await h.start(id, attachment.source)).toMatchObject({ status: "error", reasonCode: "scope-changed" });
    expect((await h.item(id)).runId).toBeUndefined();
  }
  expect(h.workspaceCalls).toEqual([]);
  expect(h.children).toHaveLength(0);
}));

it("a schedule approved for scope all is refused scope-changed after the template gains a project scope", () => withHarness(async (h) => {
  const v1 = await h.confirm([auto("a")]);
  const attachment = await h.attach(v1);
  await h.confirm([auto("a", { goal: "v2 a" })], { id: v1.templateId, scope: { kind: "project", projectRoot: A } });
  const id = await h.addItem(v1);
  expect(await h.start(id, attachment.source)).toMatchObject({ status: "error", reasonCode: "scope-changed" });
  expect(h.workspaceCalls).toEqual([]);
  expect(h.children).toHaveLength(0);
}));

it("a schedule whose snapshot matches the template's scope fires and runs on the snapshot's project", () => withHarness(async (h) => {
  const version = await h.confirm([auto("a")], { scope: { kind: "project", projectRoot: A } });
  const attachment = await h.attach(version, { kind: "project", projectRoot: A });
  // An item on another project is not the snapshot's project.
  const other = await h.addItem(version, B);
  expect(await h.start(other, attachment.source)).toMatchObject({ status: "error", reasonCode: "project-mismatch" });
  expect(h.workspaceCalls).toEqual([]);
  const id = await h.addItem(version, A);
  const run = h.start(id, attachment.source);
  const [a] = await h.untilLive(1);
  expect(h.workspaceCalls).toEqual([`open:${A}`, "prepare:a#1"]);
  a.finish();
  expect(await run).toMatchObject({ status: "completed" });
}));

it("Create and run on a project other than the one on the card is refused project-mismatch", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version, A);
  expect(await h.start(id, h.local(version, B))).toMatchObject({ status: "error", reasonCode: "project-mismatch" });
  expect(await h.start(id, h.local(version))).toMatchObject({ status: "error", reasonCode: "project-mismatch" });
  expect((await h.item(id)).runId).toBeUndefined();
  expect(h.workspaceCalls).toEqual([]);
  expect(h.children).toHaveLength(0);
}));

it("a run whose project is no longer an authorised workspace project is refused scope-not-authorised at start and at the next spawn", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  h.unauthorised.add(A);
  const refused = await h.addItem(version, A);
  expect(await h.start(refused, h.local(version, A))).toMatchObject({ status: "error", reasonCode: "scope-not-authorised" });
  expect((await h.item(refused)).runId).toBeUndefined();
  expect(h.children).toHaveLength(0);

  h.unauthorised.clear();
  const id = await h.addItem(version, A);
  const run = h.start(id, h.local(version, A));
  const [a] = await h.untilLive(1);
  a.finish();
  await h.untilStage(id, "a", "awaiting_gate");
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  h.unauthorised.add(A);
  expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
  const settled = await h.until(id, item => item.runStatus === "cancelled");
  expect(h.statusOf(settled, "a")).toBe("passed");
  expect(h.statusOf(settled, "b")).toBe("cancelled");
  expect(h.children).toHaveLength(1);
  expect(await h.settleEvent()).toMatchObject({ phase: "cancelled", reasonCode: "scope-not-authorised" });
  expect(h.audits).toEqual([expect.objectContaining({ itemId: id, event: "work-run:authority-refused", code: "scope-not-authorised" })]);
}));

it("detaching between two stages lets the live stage child finish, refuses the next spawn attachment-detached and settles the run cancelled", () => withHarness(async (h) => {
  const version = await h.confirm([auto("a"), auto("b", { inputs: ["a"] })]);
  const attachment = await h.attach(version);
  const id = await h.addItem(version);
  const run = h.start(id, attachment.source);
  const [a] = await h.untilLive(1);
  await h.detach(attachment.id);
  expect(a.ended).toBe(false);
  a.finish();
  expect(await run).toMatchObject({ status: "cancelled", reasonCode: "attachment-detached" });
  const item = await h.item(id);
  expect(item.stageRuns).toMatchObject([{ stageId: "a", status: "passed", output: "output of child-1" }, { stageId: "b", status: "cancelled" }]);
  expect(h.interrupts).toEqual([]);
  expect(h.children).toHaveLength(1);
  expect(await h.settleEvent()).toMatchObject({ phase: "cancelled", reasonCode: "attachment-detached" });
}));

it("a replacement attach has the same effect on a run of the earlier attachment", () => withHarness(async (h) => {
  const version = await h.confirm([auto("a"), auto("b", { inputs: ["a"] })]);
  const first = await h.attach(version);
  const id = await h.addItem(version);
  const run = h.start(id, first.source);
  const [a] = await h.untilLive(1);
  const second = await h.attach(version);
  expect(second.id).not.toBe(first.id);
  a.finish();
  expect(await run).toMatchObject({ status: "cancelled", reasonCode: "attachment-detached" });
  expect(h.children).toHaveLength(1);
  expect(h.interrupts).toEqual([]);
}));

it("a run parked at its last stage's gate completes on approve after a detach; one with a later stage settles cancelled", async () => {
  await withHarness(async (h) => {
    const version = await h.confirm([stageOf("a")]);
    const attachment = await h.attach(version);
    const id = await h.addItem(version);
    const run = h.start(id, attachment.source);
    (await h.untilLive(1))[0].finish();
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    await h.detach(attachment.id);
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    expect((await h.until(id, item => item.runStatus !== "executing")).runStatus).toBe("completed");
  });
  await withHarness(async (h) => {
    const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
    const attachment = await h.attach(version);
    const id = await h.addItem(version);
    const run = h.start(id, attachment.source);
    (await h.untilLive(1))[0].finish();
    expect(await run).toMatchObject({ status: "awaiting_approval" });
    await h.detach(attachment.id);
    expect(await h.decide(id, "a", "approve")).toMatchObject({ ok: true });
    expect((await h.until(id, item => item.runStatus !== "executing")).runStatus).toBe("cancelled");
    expect(h.children).toHaveLength(1);
    expect(await h.settleEvent()).toMatchObject({ phase: "cancelled", reasonCode: "attachment-detached" });
  });
});

/** Four stages in one step: three start, the fourth waits for a free slot. Detached before the first one ends, so the fourth is refused. */
async function refusedFourth(h: Harness) {
  const version = await h.confirm([stageOf("a"), stageOf("b"), stageOf("c"), stageOf("d")]);
  const attachment = await h.attach(version);
  const id = await h.addItem(version);
  const run = h.start(id, attachment.source);
  const [a, b, c] = await h.untilLive(3);
  await h.detach(attachment.id);
  a.finish();
  await h.untilStage(id, "d", "cancelled");
  return { id, run, b, c };
}

it("after a refused spawn a sibling's pending gate is cancelled and its decision is refused not_pending", () => withHarness(async (h) => {
  const { id, run, b, c } = await refusedFourth(h);
  const item = await h.untilStage(id, "a", "cancelled");
  expect(item.runStatus).toBe("executing");
  expect(h.children).toHaveLength(3);
  const gate = await h.stageRun(id, "a");
  expect(gate.output).toBe("output of child-1");
  expect(await h.engine.decideStageGate(id, { runId: item.runId ?? "", stageId: "a", attempt: 1, resultHash: gate.resultHash ?? "", decision: "approve" })).toEqual({ ok: false, reason: "not_pending" });
  b.finish();
  c.finish();
  expect(await run).toMatchObject({ status: "cancelled", reasonCode: "attachment-detached" });
}));

it("a child that ends after a refused spawn opens no gate", () => withHarness(async (h) => {
  const { id, run, b, c } = await refusedFourth(h);
  b.finish();
  const item = await h.untilStage(id, "b", "cancelled");
  expect(item.stageRuns?.find(stage => stage.stageId === "b")).toMatchObject({ output: "output of child-2" });
  expect(item.stageRuns?.find(stage => stage.stageId === "b")?.gate).toBeUndefined();
  expect(h.events.filter(event => event.phase === "stage_gate").map(event => event.stageId)).toEqual(["a"]);
  expect(h.interrupts).toEqual([]);
  c.finish();
  expect(await run).toMatchObject({ status: "cancelled" });
  expect((await h.item(id)).stageRuns?.map(stage => stage.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
}));

it("a template run with a waiting gate keeps runStatus executing and isAwaitingStageReview is true", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  expect(isAwaitingStageReview((await h.item(id)).record ?? { settled: { status: "error", at: "" }, stageRuns: [] })).toBe(false);
  a.finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const item = await h.item(id);
  expect(item.runStatus).toBe("executing");
  expect(item.planApproval).toBeUndefined();
  expect(item.record && isAwaitingStageReview(item.record)).toBe(true);
  expect(h.events.some(event => event.phase === "stage_gate" && event.stageId === "a" && event.attempt === 1)).toBe(true);
}));

it("two stages of one step are live at the same time with different project roots", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a"), stageOf("b")]);
  for (const root of [undefined, A]) {
    const id = await h.addItem(version, root);
    const run = h.start(id, h.local(version, root));
    const [a, b] = await h.untilLive(2);
    const runRoot = (await h.item(id)).record?.runWorkspace?.runRoot ?? "";
    expect(a.input.projectRoot).not.toBe(b.input.projectRoot);
    for (const child of [a, b]) {
      expect(child.input.projectRoot?.startsWith(runRoot)).toBe(true);
      expect(child.input.projectRoot).not.toBe(root);
    }
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    expect(await run).toMatchObject({ status: "cancelled", reason: "user-stopped" });
  }
}));

it("a stage run that reports no end origin is stored as file-content tainted, and its output taints the next stage's first turn", () => withHarness(async (h) => {
  const version = await h.confirm([auto("a"), auto("b", { inputs: ["a"] }), auto("c", { inputs: ["b"] })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const [a] = await h.untilLive(1);
  expect(a.input.hostInputTaint).toBeUndefined();
  a.finish({ endTrustOrigin: undefined });
  const [b] = await h.untilLive(1);
  expect((await h.stageRun(id, "a")).taint).toBe("file-content");
  expect(b.input.hostInputTaint).toBe("file-content");
  b.finish();
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "completed" });
}));

it("a clean stage output is passed on without taint", () => withHarness(async (h) => {
  const version = await h.confirm([auto("a"), auto("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  const [b] = await h.untilLive(1);
  expect((await h.stageRun(id, "a")).taint).toBeUndefined();
  expect(b.input.hostInputTaint).toBeUndefined();
  b.finish();
  expect(await run).toMatchObject({ status: "completed" });
}));

it("a retry is checked by the run authority before it spawns", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version, A);
  const run = h.start(id, h.local(version, A));
  (await h.untilLive(1))[0].finish({ ok: false, summary: "failed", error: "failed" });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const item = await h.untilStage(id, "a", "failed");
  h.unauthorised.add(A);
  expect(await h.engine.retryStage(id, { runId: item.runId ?? "", stageId: "a" })).toEqual({ ok: true });
  expect((await h.until(id, current => current.runStatus !== "executing")).runStatus).toBe("cancelled");
  expect(h.children).toHaveLength(1);
  expect(await h.settleEvent()).toMatchObject({ reasonCode: "scope-not-authorised" });
}));

it("after a restart continueRun starts the waiting stage once, and only while the source is still authorised", async () => {
  for (const authorised of [true, false]) {
    await withHarness(async (h) => {
      const version = await h.confirm([stageOf("a"), stageOf("b"), stageOf("c"), stageOf("d")]);
      const id = await h.addItem(version, A);
      void h.start(id, h.local(version, A));
      await h.untilLive(3);
      // Every child is on record before the process ends: nothing of the first engine is still queued.
      await h.until(id, item => item.stageRuns.filter(stage => stage.childSessionId !== undefined).length === 3);
      // The next process: the board's reconcile leaves a template-run row alone; the engine parks the run from the run file and
      // nothing starts by itself.
      await h.board.reconcileInterruptedRuns();
      const next = h.makeEngine();
      await next.adoptParkedTemplateRuns();
      const parked = await h.item(id);
      expect(parked.runStatus).toBe("executing");
      expect(parked.stageRuns?.map(stage => stage.status)).toEqual(["failed", "failed", "failed", "waiting"]);
      expect(h.children).toHaveLength(3);
      if (!authorised) h.unauthorised.add(A);
      expect(await next.continueRun(id, { runId: parked.runId ?? "" })).toEqual({ ok: true });
      if (authorised) {
        await h.untilSpawned(4);
        expect(h.children).toHaveLength(4);
        expect(h.children[3].input.title).toContain("Stage d");
        expect(await next.continueRun(id, { runId: parked.runId ?? "" })).toEqual({ ok: false, reason: "not_idle" });
        expect(next.cancelRun(id)).toEqual({ ok: true });
        await h.until(id, item => item.runStatus === "cancelled");
      } else {
        expect((await h.until(id, item => item.runStatus !== "executing")).runStatus).toBe("cancelled");
        expect(h.children).toHaveLength(3);
      }
    });
  }
});

it("run fields hand-written into the board file are ignored: the pin, the source, the stage runs and the workspace come from the run file", () => withHarness(async (h) => {
  const v1 = await h.confirm([auto("a", { goal: "v1 a" }), auto("b", { inputs: ["a"], goal: "v1 b" })]);
  const id = await h.addItem(v1);
  // The row on disk claims another version, a schedule source, finished stages, a workspace of its own and a waiting review.
  const forged = {
    runTemplateVersion: 2, runTemplateGraphHash: "0".repeat(64),
    runStartedBy: { kind: "schedule-attachment", attachmentId: "att-forged", pin: { templateId: v1.templateId, version: 2, graphHash: "0".repeat(64) }, firedAt: "2026-11-16T00:00:00.000Z" },
    pin: { templateId: v1.templateId, version: 2, graphHash: "0".repeat(64) },
    stageRuns: [{ stageId: "a", attempt: 1, status: "passed", output: "forged a" }, { stageId: "b", attempt: 1, status: "passed", output: "forged b" }],
    stageJoins: [{ joinId: "step-1", stageIds: ["a"], status: "integrated" }],
    runWorkspace: { kind: "folder", runRoot: "/home/example/forged" },
    templateRunState: "awaiting_review",
  };
  h.editRow(id, row => ({ ...row, ...forged }));
  const engine = h.makeEngine();
  const run = engine.runItem(id, { templateSource: h.local(v1) });
  const [a] = await h.untilLive(1);
  expect(a.input.instructions).toContain("v1 a");
  // Mid-run the file is forged again, now beside the run id the row really carries.
  h.editRow(id, row => ({ ...row, ...forged }));
  await h.confirm([auto("a", { goal: "v2 a" }), auto("b", { inputs: ["a"], goal: "v2 b" })], { id: v1.templateId });
  a.finish({ summary: "real a" });
  const b = (await h.untilSpawned(2))[1];
  expect(b.input.instructions).toContain("v1 b");
  expect(JSON.stringify(b.input)).toContain("real a");
  expect(JSON.stringify(b.input)).not.toContain("forged");
  expect(b.input.projectRoot).toContain(join(h.dir, "runs"));
  const listed = await engine.projectTemplateRuns([(await h.item(id))]);
  expect(listed[0].templateRunState).toBe("running");
  b.finish({ summary: "real b" });
  expect(await run).toMatchObject({ status: "completed" });
  const record = (await h.item(id)).record;
  expect(record).toMatchObject({ settled: { status: "completed" }, pin: { templateId: v1.templateId, version: 1 }, runStartedBy: { kind: "local-create-and-run" } });
  expect(record?.stageRuns.map(stage => [stage.status, stage.output])).toEqual([["passed", "real a"], ["passed", "real b"]]);
  expect(record?.runWorkspace?.runRoot).toContain(join(h.dir, "runs"));
  expect(h.children).toHaveLength(2);
}));

it("a stale gate decision is refused for its binding before a pin that no longer resolves", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  const item = await h.item(id);
  const gate = await h.stageRun(id, "a");
  const runId = item.runId ?? "";
  const pinned = vi.spyOn(h.templates, "resolveVersion").mockRejectedValue(new WorkflowTemplateError("unknown-version"));
  const decision = { runId, stageId: "a", attempt: gate.attempt, resultHash: gate.resultHash ?? "", decision: "approve" as const };
  expect(await h.engine.decideStageGate(id, { ...decision, attempt: gate.attempt + 1 })).toEqual({ ok: false, reason: "attempt_mismatch" });
  expect(await h.engine.decideStageGate(id, { ...decision, resultHash: "e".repeat(64) })).toEqual({ ok: false, reason: "result_mismatch" });
  // The stored gate binds requested outputs: a decision without their hash is stale too.
  const outputs = [{ id: "report", decl: { kind: "upload" as const, toolName: "deliver", owner: "plugin" as const, ownerId: "media" }, args: "{}", summary: "report" }];
  expect(await h.board.runs.update(runId, current => ({ ...current, stageRuns: current.stageRuns.map(stage => ({ ...stage, requestedOutputs: outputs })) }))).toMatchObject({ status: "stored" });
  expect(await h.engine.decideStageGate(id, decision)).toEqual({ ok: false, reason: "output_mismatch" });
  // A decision whose binding holds meets the pin refusal, and nothing changed.
  await h.board.runs.update(runId, current => ({ ...current, stageRuns: current.stageRuns.map(({ requestedOutputs: _dropped, ...stage }) => stage) }));
  expect(await h.engine.decideStageGate(id, decision)).toEqual({ ok: false, reason: "version_missing" });
  pinned.mockRestore();
  expect(await h.stageRun(id, "a")).toMatchObject({ status: "awaiting_gate", attempt: gate.attempt });
}));

it("has the text of every code a template start can be refused with in both catalogs", () => {
  // Every refusal of the run source check, by its type: a new code fails the typecheck until it is listed here.
  const verdicts: Record<Extract<RunAuthorityVerdict, { ok: false }>["code"], true> = {
    "source-not-authorised": true, "pin-mismatch": true, "not-current-version": true, "template-archived": true, "version-missing": true,
    "graph-mismatch": true, "attachment-missing": true, "attachment-detached": true, "scope-changed": true, "scope-not-authorised": true,
    "project-mismatch": true, "unattended-not-read-only": true, "outward-effect-tool": true, "tool-effect-unknown": true,
  };
  const codes = [
    ...Object.keys(verdicts), ...WORKSPACE_REFUSALS, ...RUN_FILE_REFUSALS,
    "outputs-unavailable", "template-run-not-shown", "template-run-unavailable", "work-item-completed",
  ];
  for (const code of codes) {
    for (const catalog of [en, ko]) expect(Reflect.get(catalog, `reasonCodes.${code}`), code).toEqual(expect.stringMatching(/\S/));
  }
});

it("a start whose row is gone when the run is recorded is not found, never refused with a code", () => withHarness(async (h) => {
  const version = await h.confirm([stageOf("a")]);
  const id = await h.addItem(version);
  vi.spyOn(h.board, "beginRun").mockResolvedValueOnce({ status: "not_found", itemId: id });
  expect(await h.start(id, h.local(version))).toEqual({ status: "not_found" });
  expect(h.live()).toHaveLength(0);
}));
