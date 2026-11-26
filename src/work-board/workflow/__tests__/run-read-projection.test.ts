import { expect, it } from "vitest";
import { autoStageOf, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";
import { savedWorkflowStageActivity } from "../run-read-projection.js";

it("projects recorded inputs, verdict, handoff, live steps and isolated reviewer counts", async () => {
  const breakers = new Map<string, { open: boolean; consecutive: number; total: number }>();
  const h = await stageRunHarness({ workflow: { readBreaker: id => breakers.get(id) } });
  try {
    const version = await h.confirm([
      autoStageOf("source", { gate: { type: "auto", pass: { kind: "model_verdict" } } }),
      stageOf("report", { inputs: ["source"] }), stageOf("check", { inputs: ["source"] }),
    ]);
    const id = await h.addItem(version);
    const pending = h.start(id, h.local(version));
    const [source] = await h.untilLive(1);
    const handedOff = 'Sources total five.\n\n```json\n{"verdict":"pass","reason":"The sources agree."}\n```';
    source.finish({ summary: handedOff });
    const children = await h.untilLive(2);
    for (const [index, child] of children.entries()) breakers.set(child.sessionId, { open: index === 0, consecutive: index === 0 ? 3 : 0, total: index === 0 ? 3 : 0 });
    const [first] = children;
    await h.until(id, view => children.every(child => view.stageRuns.some(stage => stage.childSessionId === child.sessionId)));
    first.reportActivity({ toolCallCount: 1, entries: [
      { kind: "assistant", text: "Reading the sources." },
      { kind: "tool_group", groupId: "turn", groupIds: ["turn"], status: "done", tools: [
        { toolUseId: "read", name: "read_file", input: { path: "reports/source.md" }, displayOrder: 0, status: "done" },
      ] },
    ] });
    const activity = {
      turns: [{ turn: 1, text: "Reading the sources." }],
      tools: [{ toolUseId: "read", name: "read_file", kind: "read", label: "source.md", status: "done", turn: 1 }],
    };
    expect(h.events).toContainEqual(expect.objectContaining({
      stageActivity: expect.objectContaining({ childSessionId: first.sessionId, activity, breaker: { open: true, consecutive: 3, total: 3 } }),
    }));
    const [row] = await h.engine.projectTemplateRuns([await h.item(id)], {});
    const receivedInputs = [{ stageId: "source", text: handedOff, truncated: false }];
    expect(row.workflowRun).toMatchObject({
      pin: h.pinOf(version),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: "source", gate: expect.objectContaining({ judgedBy: "model", evidence: "The sources agree." }) }),
        expect.objectContaining({ childSessionId: first.sessionId, receivedInputs, activity: expect.objectContaining(activity), breaker: { open: true, consecutive: 3, total: 3 } }),
        expect.objectContaining({ childSessionId: children[1].sessionId, receivedInputs, breaker: { open: false, consecutive: 0, total: 0 } }),
      ]),
      joins: [{ stageIds: ["source"], status: "integrated" }],
    });
    expect(h.events).toContainEqual(expect.objectContaining({
      workflowRun: expect.objectContaining({ stages: expect.arrayContaining([expect.objectContaining({ receivedInputs })]) }),
    }));
    for (const child of children) child.finish();
    await pending;
  } finally { for (const child of h.children) child.finish(); await h.cleanup(); }
});

it("keeps retained runs on their exact versions and reads history only for the owning row", async () => {
  const h = await stageRunHarness({ script: () => ({ ok: true, summary: "Finished" }) });
  try {
    const first = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(first);
    await h.start(id, h.local(first));
    const prior = await h.item(id);
    const next = await h.confirm([autoStageOf("a"), autoStageOf("b", { inputs: ["a"] })], { id: first.templateId });
    await h.start(id, h.local(next));
    const current = await h.item(id);
    const [listed] = await h.engine.projectTemplateRuns([current]);
    expect(listed).toMatchObject({
      runPin: h.pinOf(next), workflowRunPins: [{ runId: current.runId, pin: h.pinOf(next) }, { runId: prior.runId, pin: h.pinOf(first) }],
    });
    const [archive] = await h.engine.projectTemplateRuns([current], { runId: prior.runId });
    expect(archive.workflowRun).toMatchObject({ runId: prior.runId, pin: h.pinOf(first), stages: [{ stageId: "a", status: "passed" }] });
    const [other] = await h.engine.projectTemplateRuns([{ ...current, id: id + 1 }], { runId: prior.runId });
    expect(other.workflowRun).toBeUndefined();
    expect(other.workflowRunPins).toBeUndefined();
  } finally { await h.cleanup(); }
});

it("replays persisted child activity without tool result bodies or credential values", () => {
  expect(savedWorkflowStageActivity([
    { index: 0, role: "user", content: "Hidden host instructions" },
    { index: 1, role: "assistant", content: "Searching", toolCalls: [{ id: "call", name: "web_fetch", input: { url: "https://example.invalid/path?token=private" } }] },
    { index: 2, role: "tool_result", content: "Hidden tool output", toolUseId: "call", toolDisplay: { cancelled: true } },
  ])).toEqual({
    turns: [{ turn: 1, text: "Searching" }],
    tools: [{ toolUseId: "call", name: "web_fetch", kind: "web", label: "example.invalid/path", status: "cancelled", turn: 1 }],
  });
});
