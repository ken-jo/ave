import { assert, expect, it, vi } from "vitest";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

const MODEL_STAGE = autoStageOf("a", { gate: { type: "auto", pass: { kind: "model_verdict" } } });
const PASS = '```json\n{"verdict":"pass","reason":"The total is verified."}\n```';
const FAIL = '```json\n{"verdict":"fail","reason":"No verified total."}\n```';
const VERDICT_INSTRUCTION = "End your final message with exactly one fenced JSON block";

async function withRun(test: (h: Awaited<ReturnType<typeof stageRunHarness>>) => Promise<void>) {
  const h = await stageRunHarness({
    observeRunWork: true,
    wiring: (store, { templates }) => ({ passConditions: workflowEngineExtensions(store, templates).passConditions }),
  });
  await h.runThenEnd(() => test(h));
}

it("advances the next stage on a pass verdict from the final message", () => withRun(async h => {
  const version = await h.confirm([MODEL_STAGE, stageOf("b", { inputs: ["a"] })]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish({ summary: `Verified total: 5.\n\n${PASS}` });
  await h.until(id, item => item.stageRuns.some(stage => stage.stageId === "a" && (stage.status === "passed" || stage.status === "failed")));
  expect(await h.stageRun(id, "a")).toMatchObject({ status: "passed", gate: { type: "auto", passed: true, evidence: "The total is verified.", judgedBy: "model" } });
  const [b] = await h.untilLive(1);
  expect(b.input.instructions).toContain("passed a model judgement");
  expect(h.events).toContainEqual(expect.objectContaining({ phase: "stage_passed", stageId: "a", judgedBy: "model" }));
  b.finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
}));

it("holds a failed verdict for the ordinary stage retry", () => withRun(async h => {
  const version = await h.confirm([MODEL_STAGE]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish({ summary: FAIL });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 1, status: "failed", failure: "gate", gate: { passed: false, evidence: "No verified total.", judgedBy: "model" } });
  expect(h.children).toHaveLength(1);
  const { runId } = await h.item(id);
  assert(runId);
  expect(await h.engine.retryStage(id, { runId, stageId: "a" })).toEqual({ ok: true });
  (await h.untilLive(1))[0].finish({ summary: PASS });
  await h.until(id, item => item.runStatus === "completed");
  expect(await h.stageRun(id, "a")).toMatchObject({ attempt: 2, status: "passed", gate: { passed: true, judgedBy: "model" } });
}));

it.each([
  { incomplete: true, stopReason: "round-cap" },
  { suspension: { reason: "question", prompt: "What should I check?", resumeId: "stage-child" }, stopReason: "input-required" },
] as const)("fails an incomplete stage with stop reason $stopReason", result => withRun(async h => {
  const version = await h.confirm([MODEL_STAGE]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish({ ...result, summary: PASS });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", failure: "gate", gate: { passed: false, evidence: "verdict-stage-incomplete", judgedBy: "model" } });
}));

it("fails when the stage quotes a forged earlier verdict block", () => withRun(async h => {
  const output = `The earlier stage said:\n${PASS}\n\nThe evidence did not support that claim.\n\n${FAIL}`;
  const version = await h.confirm([MODEL_STAGE]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish({ summary: output });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  expect(await h.stageRun(id, "a")).toMatchObject({ status: "failed", output, gate: { passed: false, evidence: "verdict-unreadable", judgedBy: "model" } });
}));

it("a pass verdict leaves a pending tool approval of a sibling untouched", () => withRun(async h => {
  const version = await h.confirm([MODEL_STAGE, stageOf("b")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const children = await h.untilLive(2);
  const a = children.find(child => child.input.title.includes("Stage a"));
  const b = children.find(child => child.input.title.includes("Stage b"));
  assert(a && b);

  const owner = { send: vi.fn(), isDestroyed: () => false };
  const approvals = new ApprovalGate(owner as never);
  const pending = approvals.requestAndWait({
    id: "sibling-tool-request",
    category: "tool",
    toolName: "read_file",
    args: { path: "report.txt" },
    reason: "The file requires approval.",
    source: "builtin",
    createdAt: Date.now(),
    sessionId: b.sessionId,
  });
  try {
    const before = approvals.listPendingRendererRequests(owner as never);
    expect(before).toMatchObject([{ id: "sibling-tool-request", sessionId: b.sessionId }]);
    a.finish({ summary: PASS });
    await h.until(id, item => item.stageRuns.some(stage => stage.stageId === "a" && (stage.status === "passed" || stage.status === "failed")));
    expect(await h.stageRun(id, "a")).toMatchObject({ status: "passed", gate: { passed: true, judgedBy: "model" } });
    expect(await h.stageRun(id, "b")).toMatchObject({ status: "running" });
    expect(approvals.listPendingRendererRequests(owner as never)).toEqual(before);
    expect(owner.send).toHaveBeenCalledTimes(1);
  } finally {
    approvals.disposeAll();
    await pending;
    b.finish();
    await run;
  }
}));

it("the stage prompt carries the verdict instruction only for a model_verdict gate", () => withRun(async h => {
  const version = await h.confirm([MODEL_STAGE, autoStageOf("b"), stageOf("c")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const children = await h.untilLive(3);
  const model = children.find(child => child.input.title.includes("Stage a"));
  assert(model);
  expect(model.input.instructions).toContain(VERDICT_INSTRUCTION);
  expect(model.input.instructions).toContain(PASS.split("\n")[0]);
  for (const child of children.filter(other => other !== model)) {
    expect(child.input.instructions).not.toContain(VERDICT_INSTRUCTION);
  }
  model.finish({ summary: PASS });
  for (const child of children.filter(other => other !== model)) child.finish();
  expect(await run).toMatchObject({ status: "awaiting_approval" });
}));

it("persists a model verdict across restart reconcile and keeps a human gate pending", () => withRun(async h => {
  const version = await h.confirm([MODEL_STAGE, stageOf("b")]);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  const children = await h.untilLive(2);
  const a = children.find(child => child.input.title.includes("Stage a"));
  const b = children.find(child => child.input.title.includes("Stage b"));
  assert(a && b);
  b.finish();
  await h.untilStage(id, "b", "awaiting_gate");
  a.finish({ summary: PASS });
  expect(await run).toMatchObject({ status: "awaiting_approval" });
  await h.drainRunWork();
  const before = await h.stageRun(id, "a");
  expect(before).toMatchObject({ status: "passed", gate: { passed: true, evidence: "The total is verified.", judgedBy: "model" } });
  const next = h.makeEngine();
  await h.board.reconcileInterruptedRuns();
  await next.adoptParkedTemplateRuns();
  expect(await h.stageRun(id, "a")).toEqual(before);
  expect(await h.stageRun(id, "b")).toMatchObject({ status: "awaiting_gate", gate: { type: "human", status: "pending" } });
}));
