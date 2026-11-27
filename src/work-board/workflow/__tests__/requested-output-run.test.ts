import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { workflowEngineExtensions } from "../../../boot/steps/workflow-engine-extensions.js";
import { mintHostDecisionProof } from "../../../main/workflow-template-decision.js";
import { outputHashOf } from "../../../shared/workflow-template-output.js";
import type { ScheduleAttachment, StageEnvelope, WorkflowTemplateRecord } from "../../../shared/workflow-template-types.js";
import { mintRequestedOutputDecision } from "../requested-output-decision.js";
import { createRequestedOutputExecutor } from "../requested-output-executor.js";
import { gitFixture, sealed, stageRoot } from "./stage-git-fixture.js";
import { runScopePermissions, stageOf, writeUnder } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

const PUSH = { kind: "external-write", owner: "host", ownerId: "host:git", toolName: "git_push" } as const;
const ENVELOPE: StageEnvelope = {
  tools: [], writePaths: [], readRoots: [], commands: [], network: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: ["external-write"], budget: { rounds: 5, minutes: 1, costUsd: 0 },
};
const PUSH_STAGE = stageOf("review", { requestedOutputs: [PUSH], envelope: ENVELOPE });
const pushResponse = (remote = "origin") => JSON.stringify({
  result: "Ready to review",
  requestedOutputs: [{ id: "delivery", ...PUSH, args: { remote }, summary: "Publish result" }],
});

function wiring(store: Parameters<typeof workflowEngineExtensions>[0], { templates }: { templates: Parameters<typeof workflowEngineExtensions>[1] }) {
  return { outputs: workflowEngineExtensions(store, templates, runScopePermissions()).outputs };
}

it("stores a declared effect as hashed data and waits for a local gate", async () => {
  const h = await stageRunHarness({ observeRunWork: true, wiring });
  await h.runThenEnd(async () => {
    const version = await h.confirm([{ ...PUSH_STAGE, toolScope: "all" }]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version));
    await expect(Promise.race([started, h.untilLive(1).then(() => "child linked")])).resolves.toBe("child linked");
    const [child] = await h.untilLive(1);
    expect(child.input.toolScope.kind).toBe("parent-all");
    expect(child.input.instructions).toContain('"requestedOutputs"');
    child.finish({ summary: pushResponse() });
    await expect(started).resolves.toMatchObject({ status: "awaiting_approval" });
    const stage = await h.stageRun(id, "review");
    expect(stage).toMatchObject({
      output: "Ready to review",
      requestedOutputs: [{ id: "delivery", decl: PUSH, summary: "Publish result" }],
    });
    expect(stage.outputHash).toBe(outputHashOf(stage.output ?? "", stage.requestedOutputs ?? []));
    expect(stage.outputExecutions).toBeUndefined();
    const item = await h.item(id);
    const runId = item.runId ?? "";
    const decision = {
      runId, stageId: "review", attempt: 1, decision: "approve" as const,
      resultHash: stage.resultHash ?? "", outputHash: stage.outputHash,
    };
    const [local] = await h.engine.readTemplateRuns([item], "local-desktop");
    expect(local.pendingWorkflowDecisions).toMatchObject([{
      kind: "stage-gate", outputs: [{ payload: expect.stringContaining('"remote": "origin"') }],
    }]);
    const [generic] = await h.engine.readTemplateRuns([item]);
    expect(generic.pendingWorkflowDecisions).toEqual([]);
    await expect(h.engine.decideStageGate(id, decision)).resolves.toEqual({ ok: false, reason: "user-keyboard-required" });

    const changeHash = async (hash: string | undefined) => {
      expect(await h.board.runs.update(runId, run => ({
        ...run, stageRuns: run.stageRuns.map(candidate => ({ ...candidate, outputHash: hash })),
      }))).toMatchObject({ status: "stored" });
    };
    await changeHash("0".repeat(64));
    await expect(h.engine.decideStageGate(id, decision, mintRequestedOutputDecision(id, decision))).resolves.toEqual({ ok: false, reason: "output_mismatch" });
    const stale = { ...decision, outputHash: "0".repeat(64) };
    await expect(h.engine.decideStageGate(id, stale, mintRequestedOutputDecision(id, stale))).resolves.toEqual({ ok: false, reason: "output_mismatch" });
    await changeHash(stage.outputHash);
    const receipt = mintRequestedOutputDecision(id, decision);
    await expect(h.engine.decideStageGate(id, stale, receipt)).resolves.toEqual({ ok: false, reason: "output_mismatch" });
    await expect(h.engine.decideStageGate(id, decision, receipt)).resolves.toEqual({ ok: false, reason: "user-keyboard-required" });

    await expect(h.engine.decideStageGate(id, decision, mintRequestedOutputDecision(id, decision))).resolves.toEqual({ ok: true, status: "approved" });
    expect((await h.stageRun(id, "review")).outputExecutions).toMatchObject([{ id: "delivery", status: "denied", detail: "capability-unavailable" }]);
    await expect(h.engine.decideStageGate(id, decision, mintRequestedOutputDecision(id, decision))).resolves.toMatchObject({ ok: false });
  });
});

it("executes a local branch after the approved attempt is sealed", async () => {
  const fixture = gitFixture();
  const workspace = fixture.start().provider;
  try {
    const h = await stageRunHarness({
      observeRunWork: true,
      workflow: {
        workspace, outputs: { execute: createRequestedOutputExecutor(workspace.keepOutputBranch) },
      },
    });
    await h.runThenEnd(async () => {
      const version = await h.confirm([stageOf("review", {
        toolScope: "all", envelope: { ...ENVELOPE, outputs: ["branch"] },
      })], { scope: { kind: "project", projectRoot: fixture.repo } });
      const id = await h.addItem(version, fixture.repo);
      const started = h.start(id, h.local(version, fixture.repo));
      const [child] = await h.untilLive(1);
      if (!child.input.projectRoot) throw new Error("Stage workspace is missing");
      writeUnder(child.input.projectRoot, "review.txt", "approved result\n");
      child.finish({ summary: JSON.stringify({
        result: "Ready",
        requestedOutputs: [{ id: "keep", kind: "branch", owner: "host", ownerId: "host:git", toolName: "git_branch", args: {}, summary: "Retain the stage" }],
      }) });
      await expect(started).resolves.toMatchObject({ status: "awaiting_approval" });
      const run = await h.item(id);
      const ref = `refs/heads/ave/run-${run.runId}/review`;
      expect(fixture.userGit(fixture.repo, "for-each-ref", ref)).toBe("");
      const stage = run.stageRuns[0];
      const decision = {
        runId: run.runId ?? "", stageId: "review", attempt: 1, decision: "approve" as const,
        resultHash: stage.resultHash ?? "", outputHash: stage.outputHash,
      };
      await expect(h.engine.decideStageGate(id, decision, mintRequestedOutputDecision(id, decision))).resolves.toEqual({ ok: true, status: "approved" });
      const ended = await h.until(id, item => item.runStatus === "completed");
      expect(ended.stageRuns[0].outputExecutions).toMatchObject([{ id: "keep", status: "done" }]);
      expect(fixture.userGit(fixture.repo, "rev-parse", ref)).toBe(ended.stageRuns[0].workspace?.sealCommit);
      expect(fixture.userGit(fixture.repo, "show", `${ref}:review.txt`)).toBe("approved result");
    });
  } finally {
    await fixture.done();
  }
});

it("collects data from an unattended fixture while production attachment admission refuses the version", async () => {
  const h = await stageRunHarness({
    observeRunWork: true, wiring,
    workflow: {
      unattendedAllowed: () => ({ ok: true }),
      lane: { admit: async () => ({ ok: true }), sessionLinked: vi.fn(), sessionEnded: vi.fn(), onDenied: () => () => {} },
    },
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm([PUSH_STAGE]);
    const pin = h.pinOf(version);
    const proof = mintHostDecisionProof("local-desktop");
    await expect(h.templates.attachSchedule({ scheduleId: "daily", ...pin }, proof, { kind: "all" })).rejects.toMatchObject({ code: "schedule-requires-read-only" });

    // The fixture stands in for an attachment admitted after the interim restriction is lifted.
    const attachment: ScheduleAttachment = {
      ...pin, scheduleId: "daily", approvedScope: { kind: "all" }, id: "local-fixture",
      who: "user", origin: "local-desktop", at: proof.decidedAt,
    };
    const path = join(h.dir, "templates.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { templates: WorkflowTemplateRecord[] };
    file.templates[0].scheduleAttachments = [attachment];
    writeFileSync(path, JSON.stringify(file));
    const start = h.engine.startScheduledTemplate({ kind: "schedule-attachment", pin, attachmentId: attachment.id, firedAt: proof.decidedAt }, "Scheduled report");
    const [child] = await h.untilLive(1);
    expect(child.input.unattendedStage).toMatchObject({ stageId: "review" });
    expect(child.input.toolScope).toEqual({ kind: "exactly", names: ["read_file", "grep_files"] });
    child.finish({ summary: pushResponse() });
    const started = await start;
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.code);
    await expect(started.result).resolves.toMatchObject({ status: "awaiting_approval" });
    expect(await h.stageRun(started.itemId, "review")).toMatchObject({
      requestedOutputs: [{ id: "delivery", decl: PUSH }],
      outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      gate: { status: "pending" },
    });
    expect((await h.stageRun(started.itemId, "review")).outputExecutions).toBeUndefined();
  });
});

it("holds output effects across rejected and superseded attempts", async () => {
  const execute = vi.fn();
  const h = await stageRunHarness({
    observeRunWork: true,
    workflow: { outputs: { execute } },
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm([PUSH_STAGE]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish({ summary: pushResponse() });
    await started;
    const first = await h.stageRun(id, "review");
    const runId = (await h.item(id)).runId ?? "";
    const binding = { runId, stageId: "review", attempt: 1, resultHash: first.resultHash ?? "", outputHash: first.outputHash };
    await expect(h.engine.decideStageGate(id, { ...binding, decision: "request_changes", note: "Change the delivery" })).resolves.toMatchObject({ ok: true });
    (await h.untilLive(1))[0].finish({ summary: pushResponse("secondary") });
    await h.untilStage(id, "review", "awaiting_gate");
    const second = await h.stageRun(id, "review");
    expect(second.requestedOutputs?.[0].args).toContain('"remote":"secondary"');
    const approval = { ...binding, decision: "approve" as const };
    await expect(h.engine.decideStageGate(id, approval, mintRequestedOutputDecision(id, approval))).resolves.toEqual({ ok: false, reason: "attempt_mismatch" });
    await expect(h.engine.decideStageGate(id, { ...binding, attempt: 2, resultHash: second.resultHash ?? "", outputHash: second.outputHash, decision: "reject" })).resolves.toMatchObject({ ok: true });
    expect((await h.stageRun(id, "review")).outputExecutions).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

it("leaves an unconfirmed approved output alone after a restart", async () => {
  const execute = vi.fn();
  const h = await stageRunHarness({ observeRunWork: true, workflow: { outputs: { execute } } });
  await h.runThenEnd(async () => {
    const version = await h.confirm([PUSH_STAGE]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish({ summary: pushResponse() });
    await expect(started).resolves.toMatchObject({ status: "awaiting_approval" });
    const runId = (await h.item(id)).runId ?? "";
    expect(await h.board.runs.update(runId, run => ({
      ...run, stageRuns: run.stageRuns.map(stage => ({
        ...stage, status: "passed", gate: { type: "human", status: "approved", revision: 0 },
        outputExecutions: [{ id: "delivery", status: "pending" }],
      })),
    }))).toMatchObject({ status: "stored" });
    const restarted = h.makeEngine();
    await restarted.adoptParkedTemplateRuns();
    await restarted.continueRun(id, { runId });
    await h.drainRunWork();
    expect((await h.stageRun(id, "review")).outputExecutions).toEqual([{ id: "delivery", status: "pending" }]);
    expect(execute).not.toHaveBeenCalled();
  });
});

it("creates and retains only the sealed stage branch without replacing an existing ref", async () => {
  const fixture = gitFixture();
  try {
    const { provider, run } = fixture.start();
    const git = (...args: string[]) => fixture.userGit(fixture.repo, ...args);
    await expect(provider.open(run, fixture.repo)).resolves.toMatchObject({ ok: true });
    const stage = await stageRoot({ provider, run }, "review");
    const ref = `refs/heads/ave/run-${run.runId}/review`;
    writeUnder(stage, "review.txt", "approved result\n");
    const commit = await sealed({ provider, run }, "review");
    expect(commit).toBeDefined();
    expect(git("for-each-ref", ref)).toBe("");
    await expect(provider.keepOutputBranch(run, "review", 1, () => false)).resolves.toEqual({ ok: false, code: "output-execution-interrupted" });
    expect(git("for-each-ref", ref)).toBe("");

    git("update-ref", ref, "HEAD");
    await expect(provider.keepOutputBranch(run, "review", 1, () => true)).resolves.toEqual({ ok: false, code: "output-branch-taken" });
    expect(git("rev-parse", ref)).toBe(git("rev-parse", "HEAD"));
    git("update-ref", "-d", ref);
    await expect(provider.keepOutputBranch(run, "review", 1, () => true)).resolves.toEqual({ ok: true });
    await expect(provider.keepOutputBranch(run, "review", 1, () => true)).resolves.toEqual({ ok: true });
    expect(git("rev-parse", ref)).toBe(commit);
    await provider.release(run, "all");
    expect(git("rev-parse", ref)).toBe(commit);
  } finally {
    await fixture.done();
  }
});
