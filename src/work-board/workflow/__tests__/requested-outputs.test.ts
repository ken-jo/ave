import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { securitySettingsGestures } from "../../../ipc/security-settings-gesture.js";
import { en } from "../../../i18n/messages/en.js";
import { ko } from "../../../i18n/messages/ko.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { workBoardDecisionKey } from "../../../shared/work-board-decision-intent.js";
import { outputHashOf, resultHashOf } from "../../../shared/workflow-template-output.js";
import type { StageEnvelope } from "../../../shared/workflow-template-types.js";
import { createHostGit } from "../host-git.js";
import { acceptRequestedOutput, createRequestedOutputHooks, requestedOutputHash, stageOutputIntake, type GovernedOutputAdapter } from "../requested-outputs.js";
import { runBranch } from "../workspace-layout.js";
import { stageOf } from "./stage-fixtures.js";
import { fixturePushRemote, gitFixture } from "./stage-git-fixture.js";
import { stageRunHarness } from "./stage-run-harness.js";

const DELIVER = { kind: "send-message", toolName: "deliver", owner: "plugin", ownerId: "delivery" } as const;
const PUSH = { kind: "external-write", toolName: "git_push", owner: "host", ownerId: "host:git" } as const;
const STAGE = stageOf("review", { requestedOutputs: [DELIVER] });
const REQUEST = { toolName: "deliver", owner: "plugin", ownerId: "delivery", args: { body: "Ready" }, summary: "Deliver" } as const;
const ENVELOPE: StageEnvelope = { tools: [], writePaths: [], readRoots: [], commands: [], network: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: ["branch"], budget: { rounds: 5, minutes: 1, costUsd: 0 } };

const accept = (raw: unknown, stage = STAGE) => acceptRequestedOutput({ stage, workspaceRoot: process.cwd(), raw,
  run: { itemId: 1, runId: "sample", runKey: "sample" } }, createHostGit());

it("refuses a tool the stage does not declare with reasonCode output-not-declared, which has an en and a ko message", async () => {
  const hooks = createRequestedOutputHooks(createHostGit(), { invoke: vi.fn() }, process.cwd());
  const intake = stageOutputIntake(hooks, { stage: STAGE, workspaceRoot: process.cwd(), run: { itemId: 1, runId: "sample", runKey: "sample" } });
  await expect(intake.tool.execute({ ...REQUEST, toolName: "undeclared" }, { cwd: process.cwd(), metadata: {}, extraAllowedDirectories: [] }))
    .resolves.toEqual({ isError: true, output: '{"reasonCode":"output-not-declared"}' });
  expect(en["reasonCodes.output-not-declared"]).toBeTruthy();
  expect(ko["reasonCodes.output-not-declared"]).toBeTruthy();
});

it("refuses a declared tool name under another owner id", async () => {
  await expect(accept({ ...REQUEST, ownerId: "elsewhere" })).resolves.toEqual({ ok: false, code: "output-not-declared" });
  await expect(accept({ ...REQUEST, owner: "server" })).resolves.toEqual({ ok: false, code: "output-not-declared" });
});

it("refuses a name that only starts with or contains a declared tool name", async () => {
  for (const toolName of ["deliver_more", "do_deliver"]) {
    await expect(accept({ ...REQUEST, toolName })).resolves.toEqual({ ok: false, code: "output-not-declared" });
  }
});

it("the kind of an entry does not change what matches", async () => {
  for (const kind of ["upload", "send-message", "publish-post", "external-write", "other"] as const) {
    await expect(accept(REQUEST, { ...STAGE, envelope: ENVELOPE, requestedOutputs: [{ ...DELIVER, kind }] })).resolves.toMatchObject({
      ok: true, output: { decl: { ...DELIVER, kind }, args: '{"body":"Ready"}' },
    });
  }
});

it("a call to a plugin tool named git_push does not match the host:git entry", async () => {
  await expect(accept({ ...REQUEST, toolName: PUSH.toolName, args: { remote: "origin" } }, { ...STAGE, requestedOutputs: [PUSH] }))
    .resolves.toEqual({ ok: false, code: "output-not-declared" });
});

it("bounds intake and refuses a stage without a human gate", async () => {
  await expect(accept({ ...REQUEST, args: { text: "x".repeat(33 * 1024) } })).resolves.toEqual({ ok: false, code: "args-too-large" });
  await expect(accept(REQUEST, { ...STAGE, gate: { type: "auto", pass: { kind: "always" } } } as never))
    .resolves.toEqual({ ok: false, code: "needs-human-gate" });
  const intake = stageOutputIntake(createRequestedOutputHooks(createHostGit(), { invoke: vi.fn() }, process.cwd()), {
    stage: STAGE, workspaceRoot: process.cwd(), run: { itemId: 1, runId: "sample", runKey: "sample" },
  });
  const ctx = { cwd: process.cwd(), metadata: {}, extraAllowedDirectories: [] };
  for (let i = 0; i < 10; i++) await expect(intake.tool.execute(REQUEST, ctx)).resolves.toMatchObject({ isError: false });
  await expect(intake.tool.execute(REQUEST, ctx)).resolves.toMatchObject({ isError: true, output: '{"reasonCode":"too-many"}' });
  expect(intake.close()).toHaveLength(10);
});

it.each([
  ["a masked value", { body: "(202)\t555-0100" }],
  ["an omitted key", JSON.parse('{"nested":{"__proto__":{"body":"Ready"}}}')],
] as const)("refuses output arguments when the card would lose %s", async (_reason, args) => {
  await expect(accept({ ...REQUEST, args })).resolves.toEqual({ ok: false, code: "output-args-not-displayable" });
});

it("refuses an invisible character escaped by JSON serialization", async () => {
  await expect(accept({ ...REQUEST, args: { body: "line\u0000end" } })).resolves.toEqual({ ok: false, code: "args-too-large" });
});

it("a request carrying files is refused args-too-large and nothing reaches the gate", async () => {
  const intake = stageOutputIntake(createRequestedOutputHooks(createHostGit(), { invoke: vi.fn() }, process.cwd()), {
    stage: STAGE, workspaceRoot: process.cwd(), run: { itemId: 1, runId: "sample", runKey: "sample" },
  });
  await expect(intake.tool.execute({ ...REQUEST, files: [] }, { cwd: process.cwd(), metadata: {}, extraAllowedDirectories: [] }))
    .resolves.toEqual({ isError: true, output: '{"reasonCode":"args-too-large"}' });
  expect(intake.close()).toEqual([]);
});

it("outputHash changes when an output changes and resultHash does not", async () => {
  const checked = await accept(REQUEST);
  if (!checked.ok) throw new Error(checked.code);
  const output = "Ready";
  const base = { output, resultHash: resultHashOf(output) };
  const first = { ...base, requestedOutputs: [checked.output] };
  const second = { ...base, requestedOutputs: [{ ...checked.output, args: '{"body":"Changed"}' }] };
  expect(outputHashOf(first.output, first.requestedOutputs)).not.toBe(outputHashOf(second.output, second.requestedOutputs));
  expect(first.resultHash).toBe(second.resultHash);
});

function gesture(channel: typeof WORK_BOARD.decideStage | typeof WORK_BOARD.retryOutput, id: number, input: unknown) {
  const events = new EventEmitter();
  const surface = Object.assign(events, { isDestroyed: () => false }) as unknown as WebContents;
  securitySettingsGestures.observe(surface);
  events.emit("before-mouse-event", {}, { type: "mouseUp" });
  const proof = securitySettingsGestures.consume(surface, { channel, payload: workBoardDecisionKey(channel, id, input) });
  if (!proof) throw new Error("Missing native gesture receipt");
  return { surface, proof };
}

async function parked(body: (fixture: Awaited<ReturnType<typeof stageRunHarness>>, id: number, binding: {
  stageId: string; runId: string; attempt: number; resultHash: string; outputHash: string; decision: "approve";
}, invoke: ReturnType<typeof vi.fn>) => Promise<void>, opts: { calls?: number; refuseBeforeDispatch?: boolean } = {}) {
  const invoke = vi.fn<GovernedOutputAdapter["invoke"]>(async () => "done");
  if (opts.refuseBeforeDispatch) invoke.mockResolvedValueOnce("output-execution-not-dispatched");
  const fixture = await stageRunHarness({ observeRunWork: true, workflow: {
    outputs: createRequestedOutputHooks(createHostGit(), { invoke }, process.cwd()),
  } });
  await fixture.runThenEnd(async () => {
    const version = await fixture.confirm([{ ...STAGE, toolScope: "all" }]);
    const id = await fixture.addItem(version);
    const launched = fixture.start(id, fixture.local(version));
    const [child] = await fixture.untilLive(1);
    const tool = child.input.stageOutputTool;
    const cwd = child.input.projectRoot;
    if (!tool || !cwd) throw new Error("Expected a scoped stage tool");
    for (let i = 0; i < (opts.calls ?? 1); i++) {
      expect(await tool.execute(REQUEST, { cwd, metadata: {}, extraAllowedDirectories: [] }))
        .toMatchObject({ isError: false });
    }
    child.finish({ summary: "Prose result" });
    await expect(launched).resolves.toMatchObject({ status: "awaiting_approval" });
    const item = await fixture.item(id);
    const stage = item.stageRuns[0];
    const hash = requestedOutputHash(stage);
    if (!item.runId || !stage.resultHash || !hash) throw new Error("Missing stored request");
    await body(fixture, id, { stageId: "review", runId: item.runId, attempt: 1, resultHash: stage.resultHash, outputHash: hash, decision: "approve" }, invoke);
  });
}

it("records an output and executes nothing", () => parked(async (h, id, binding, invoke) => {
  const stage = await h.stageRun(id, "review");
  expect(stage).toMatchObject({ output: "Prose result", requestedOutputs: [{ decl: DELIVER }] });
  expect(stage).not.toHaveProperty("outputHash");
  expect(stage.outputExecutions).toBeUndefined();
  expect((await h.engine.readTemplateRuns([await h.item(id)], "local-desktop"))[0].pendingWorkflowDecisions).toMatchObject([
    { binding: { outputHash: binding.outputHash } },
  ]);
  expect(invoke).not.toHaveBeenCalled();
}));

it("an approve with the right resultHash and a stale outputHash is refused", () => parked(async (h, id, binding, invoke) => {
  const stale = { ...binding, outputHash: "0".repeat(64) };
  await expect(h.engine.decideStageGate(id, stale, { kind: "local-desktop", receipt: gesture(WORK_BOARD.decideStage, id, stale) })).resolves.toEqual({ ok: false, reason: "output_mismatch" });
  expect(invoke).not.toHaveBeenCalled();
}));

it("approve executes each output once through the permission check", () => parked(async (h, id, binding, invoke) => {
  const receipt = gesture(WORK_BOARD.decideStage, id, binding);
  await expect(h.engine.decideStageGate(id, binding)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
  await expect(h.engine.decideStageGate(id, binding, { kind: "local-desktop", receipt })).resolves.toEqual({ ok: true, status: "approved" });
  await expect(h.engine.decideStageGate(id, binding, { kind: "local-desktop", receipt })).resolves.toMatchObject({ ok: false });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ output: expect.objectContaining({ args: JSON.stringify(REQUEST.args) }), surface: receipt.surface }));
}, { calls: 2 }));

it("a rejected gate executes nothing", () => parked(async (h, id, binding, invoke) => {
  await expect(h.engine.decideStageGate(id, { ...binding, decision: "reject" })).resolves.toMatchObject({ ok: true });
  expect(invoke).not.toHaveBeenCalled();
}));

it("an output that failed before dispatch leaves the stage passed and can be retried under the same hash", () => parked(async (h, id, binding, invoke) => {
  await expect(h.engine.decideStageGate(id, binding, { kind: "local-desktop", receipt: gesture(WORK_BOARD.decideStage, id, binding) })).resolves.toMatchObject({ ok: true });
  await h.until(id, item => item.runStatus === "completed");
  const stage = await h.stageRun(id, "review");
  expect(stage).toMatchObject({ status: "passed", outputExecutions: [{ status: "failed", detail: "output-execution-not-dispatched" }] });
  const { runId, stageId, attempt, outputHash } = binding;
  const retry = { runId, stageId, attempt, outputHash, outputId: stage.outputExecutions?.[0].id ?? "" };
  await expect(h.engine.retryOutput(id, retry, gesture(WORK_BOARD.retryOutput, id, retry))).resolves.toEqual({ ok: true });
  expect((await h.stageRun(id, "review")).outputExecutions).toMatchObject([{ status: "done" }]);
  expect(invoke).toHaveBeenCalledTimes(2);
}, { refuseBeforeDispatch: true }));

it.each(["missing workspace", "unconfirmed execution"] as const)("handles %s after restart without calling the tool again", scenario => parked(async (h, id, binding, invoke) => {
  await expect(h.engine.decideStageGate(id, binding, { kind: "local-desktop", receipt: gesture(WORK_BOARD.decideStage, id, binding) }))
    .resolves.toMatchObject({ ok: true });
  await h.until(id, item => item.runStatus === "completed");
  const { runId, stageId, attempt, outputHash } = binding;
  const [outcome] = (await h.stageRun(id, stageId)).outputExecutions ?? [];
  if (!outcome) throw new Error("Missing output outcome");
  expect(await h.board.updateRun(id, runId, run => ({
    ...run,
    stageRuns: run.stageRuns.map(stage => stage.stageId !== stageId ? stage
      : scenario === "missing workspace" ? { ...stage, workspace: undefined }
        : { ...stage, outputExecutions: [{ id: outcome.id, status: "pending" }] }),
  }))).toMatchObject({ status: "stored" });
  const engine = h.makeEngine();
  await engine.adoptParkedTemplateRuns();
  const retry = { runId, stageId, attempt, outputHash, outputId: outcome.id };
  const receipt = gesture(WORK_BOARD.retryOutput, id, retry);
  if (scenario === "missing workspace") {
    await expect(engine.retryOutput(id, retry, receipt)).resolves.toEqual({ ok: true });
    expect((await h.stageRun(id, stageId)).outputExecutions).toMatchObject([{ status: "failed", detail: "workspace-unavailable" }]);
  } else {
    await expect(engine.retryOutput(id, retry, receipt)).resolves.toEqual({ ok: false, reason: "not_pending" });
    expect((await h.stageRun(id, stageId)).outputExecutions).toEqual([{ id: outcome.id, status: "pending" }]);
  }
  expect(invoke).toHaveBeenCalledTimes(1);
}, { refuseBeforeDispatch: true }));

async function pushGate(decision: "approve" | "reject", changeRef = false) {
  const fixture = gitFixture();
  const remote = join(fixture.base, "endpoint.git");
  fixture.userGit(fixture.base, "init", "--bare", remote);
  fixture.userGit(fixture.repo, "remote", "add", "origin", fixturePushRemote(fixture, remote));
  const { provider } = fixture.start();
  const h = await stageRunHarness({ observeRunWork: true, workflow: {
    workspace: provider, outputs: createRequestedOutputHooks(createHostGit({ env: fixture.env }), { invoke: vi.fn() }, process.cwd()),
  } });
  try {
    await h.runThenEnd(async () => {
      const version = await h.confirm([stageOf("review", { requestedOutputs: [PUSH] })], { scope: { kind: "project", projectRoot: fixture.repo } });
      const id = await h.addItem(version, fixture.repo);
      const started = h.start(id, h.local(version, fixture.repo));
      const [child] = await h.untilLive(1);
      const cwd = child.input.projectRoot ?? "";
      expect(await child.input.stageOutputTool?.execute({ toolName: PUSH.toolName, owner: PUSH.owner, ownerId: PUSH.ownerId,
        args: { remote: "origin" }, summary: "Publish run branch" }, { cwd, metadata: {}, extraAllowedDirectories: [] })).toMatchObject({ isError: false });
      writeFileSync(join(cwd, "a.txt"), "Stage output");
      child.finish({ summary: "Ready" });
      await started;
      const item = await h.item(id);
      const ref = `refs/heads/${runBranch(item.runId ?? "")}`;
      const approvedHead = fixture.userGit(fixture.repo, "rev-parse", ref);
      expect(fixture.userGit(remote, "for-each-ref")).toBe("");
      const stage = item.stageRuns[0];
      expect((await h.engine.readTemplateRuns([item], "local-desktop"))[0].pendingWorkflowDecisions)
        .toMatchObject([{ outputs: [{ pushRunBranch: true, payload: expect.stringContaining(approvedHead) }] }]);
      if (changeRef) {
        writeFileSync(join(fixture.repo, "payload.txt"), "A later payload");
        fixture.commitAll("A later commit");
        fixture.userGit(fixture.repo, "update-ref", ref, "HEAD");
      }
      const binding = { runId: item.runId ?? "", stageId: "review", attempt: 1, decision,
        resultHash: stage.resultHash ?? "", outputHash: requestedOutputHash(stage) };
      await expect(h.engine.decideStageGate(id, binding, { kind: "local-desktop", receipt: gesture(WORK_BOARD.decideStage, id, binding) })).resolves.toMatchObject({ ok: true });
      expect(fixture.userGit(remote, "for-each-ref", "--format=%(refname)")).toBe(decision === "approve" && !changeRef ? ref : "");
      if (decision === "approve") {
        const approved = await h.stageRun(id, "review");
        const [outcome] = approved.outputExecutions ?? [];
        if (!changeRef) {
          const pushed = fixture.userGit(remote, "rev-parse", ref);
          expect(pushed).toBe(approvedHead);
          expect(approved.workspace?.sealCommit).toMatch(/^[a-f0-9]{40}$/u);
          expect(pushed).not.toBe(approved.workspace?.sealCommit);
          expect(fixture.userGit(remote, "show", `${ref}:a.txt`)).toBe("one");
        }
        expect(outcome?.status).toBe(changeRef ? "failed" : "done");
        if (changeRef) expect(outcome?.detail).toBe("push-ref-changed");
        const retry = { runId: binding.runId, stageId: binding.stageId, attempt: binding.attempt,
          outputHash: binding.outputHash ?? "", outputId: outcome?.id ?? "" };
        await expect(h.engine.retryOutput(id, retry, gesture(WORK_BOARD.retryOutput, id, retry)))
          .resolves.toEqual({ ok: false, reason: "push-retry-forbidden" });
        await expect(h.engine.decideStageGate(id, binding, { kind: "local-desktop", receipt: gesture(WORK_BOARD.decideStage, id, binding) })).resolves.toMatchObject({ ok: false });
      }
    });
  } finally { await fixture.done(); }
}

it("a host Git push sends the run head bound at request without the stage seal commit", () => pushGate("approve"));
it("a rejected gate pushes nothing", () => pushGate("reject"));
it("retry-output refuses a failed push", () => pushGate("approve", true));
it("one approval pushes at most once: a second execution and retry-output both send nothing", () => pushGate("approve"));

it("an envelope with its default branch and no declarations still parks a prose result", async () => {
  const h = await stageRunHarness({ observeRunWork: true });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("review", { envelope: ENVELOPE })]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    expect(child.input.stageOutputTool).toBeUndefined();
    child.finish({ summary: "Report ready" });
    await expect(started).resolves.toMatchObject({ status: "awaiting_approval" });
    expect(await h.stageRun(id, "review")).toMatchObject({ output: "Report ready", status: "awaiting_gate" });
  });
});
