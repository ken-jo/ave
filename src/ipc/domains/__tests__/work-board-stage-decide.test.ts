import { shell } from "electron";
import { deliverWorkBoardProgress } from "../../work-board-project-scope.js";
import type { MainWindow } from "../../../main/main-window-host.js";
import * as permissionSettings from "../../../permissions/permission-settings-store.js";
import { workBoardDecisionKey, type WorkBoardDecisionChannel } from "../../../shared/work-board-decision-intent.js";
import { captureWorkBoardTestGesture, workBoardTestSender } from "../../../__tests__/support/work-board-ipc.js";
import { registerWorkApprovalsHandlers } from "../work-approvals.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
// A stage gate, a join decision, a stage retry and the start of a template run are work approvals: a sender-validated board-window main
// frame with a consumed keyboard gesture. The renderer names hashes and ids; it never mints the run source.
import { beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import * as namespace from "../../../main/storage/feature-namespace.js";
import { autoStageOf, stageOf } from "../../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../../work-board/workflow/__tests__/stage-run-harness.js";
import { WORK_APPROVALS, WORK_BOARD } from "../../../shared/ipc-channels.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import type { IpcDeps } from "../../types.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../../gated.js";
import { defaultWorkspaceProject } from "../../../main/project-root-authorization.js";
import { resultHashOf } from "../../../shared/workflow-template-output.js";
import { MAX_PLAN_NOTE_LENGTH, workBoardOriginSessionId } from "../../../shared/work-board-types.js";
import { registeredIpcHandlers } from "./test-helpers.js";

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return { handlers, handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) };
});

vi.mock("electron", () => {
  const electron = { ipcMain: { handle: ipc.handle }, shell: { openPath: vi.fn(async () => "") } };
  return { ...electron, default: electron };
});

vi.mock("../../gated.js", () => ({
  validateHostRendererSender: vi.fn(() => true),
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" },
  auditUnauthorized: vi.fn(),
}));

const GESTURE = { inputOrigin: "user-keyboard", userActivation: true } as const;
const RUN = "0b0f5a9e-3a52-4c8e-9d0b-6f2f1c1f7a11";
const HASH = "a".repeat(64);
const TUPLE = { templateId: "tpl-1", version: 1, graphHash: HASH };
const gateInput = { runId: RUN, stageId: "a", attempt: 1, resultHash: HASH, decision: "approve" };
const joinInput = { runId: RUN, joinId: "step-1", conflictHash: HASH, decision: "retry_merge" };
const retryInput = { runId: RUN, stageId: "a" };

const handler = registeredIpcHandlers(ipc.handlers);
const decide = async (
  channel: WorkBoardDecisionChannel,
  event: { sender: ReturnType<typeof workBoardTestSender> },
  itemId: unknown, input: unknown,
) => handler(channel)(event, itemId, input, await captureWorkBoardTestGesture(handler, event, channel, itemId, input));
const bindDefaultProject = (event: unknown) => handler(WORK_BOARD.setProjectScope)(event, defaultWorkspaceProject().projectRoot);

function setup(privacy: { piiRedactEnabled: boolean } = { piiRedactEnabled: false }) {
  const owner = workBoardTestSender();
  const window = { isDestroyed: () => false, webContents: owner };
  const engine = {
    decidePlan: vi.fn(async () => ({ result: { ok: true, status: "approved" } })),
    decideStageGate: vi.fn(async () => ({ ok: true, status: "approved" })),
    decideStageJoin: vi.fn(async () => ({ ok: true })),
    retryStage: vi.fn(async () => ({ ok: true })),
    projectTemplateRuns: vi.fn(async (items: unknown[]) => items),
    runItem: vi.fn(async () => ({ status: "awaiting_approval" })),
    steerRun: vi.fn(() => ({ ok: true, messageId: "m-1" })),
    adoptParkedTemplateRuns: vi.fn(async () => {}),
  };
  const log = vi.fn();
  const base = { title: "t", status: "in_progress", status_resolved: "in_progress", priority: "medium", created_at: "x", updated_at: "x" };
  registerWorkBoardHandlers({
    workBoardStore: {
      get: async (id: number) => id === 7 ? { status: "found", item: { ...base, id: 7 } }
        : id === 9 ? { status: "found", item: { ...base, id: 9 } }
        : { status: "not_found", itemId: id },
    },
    workBoardEngine: engine,
    settingsService: { get: (key: string) => (key === "privacy" ? privacy : undefined) },
    auditLogger: { log },
    getMainWindow: () => window,
    getAppWindows: () => [window],
  } as unknown as IpcDeps);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  return { event, engine, log };
}

const decisions = [
  [WORK_BOARD.decideStage, gateInput, "decideStageGate"],
  [WORK_BOARD.decideJoin, joinInput, "decideStageJoin"],
  [WORK_BOARD.retryStage, retryInput, "retryStage"],
] as const;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  ipc.handlers.clear();
  vi.mocked(validateHostRendererSender).mockReturnValue(true);
  vi.mocked(auditUnauthorized).mockClear();
});

it("refuses without a keyboard gesture or from a non-owner frame", async () => {
  const { event, engine, log } = setup();
  const subframe = { ...event, senderFrame: { url: "file:///index.html" } };
  for (const [channel, input, method] of decisions) {
    for (const intent of [undefined, GESTURE, { inputOrigin: "user-keyboard", userActivation: false }, { inputOrigin: "queue-auto", userActivation: true }]) {
      await expect(handler(channel)(event, 7, input, intent)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
    }
    await expect(handler(channel)(subframe, 7, input, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    // A non-owner frame learns nothing about which items exist.
    await expect(handler(channel)(subframe, 8, input, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    vi.mocked(validateHostRendererSender).mockReturnValueOnce(false);
    await expect(handler(channel)(event, 7, input, GESTURE)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(engine[method]).not.toHaveBeenCalled();
  }
  expect(auditUnauthorized).toHaveBeenCalledTimes(9);
  expect(log).not.toHaveBeenCalled();
});

it("forwards a gesture-carrying decision with the host's approval surface and audits the decision, never the note", async () => {
  const { event, engine, log } = setup();
  await expect(decide(WORK_BOARD.decideStage, event, 7, { ...gateInput, decision: "request_changes", note: "tighten the summary" })).resolves.toEqual({ ok: true, status: "approved" });
  expect(engine.decideStageGate).toHaveBeenCalledWith(7, { ...gateInput, decision: "request_changes", note: "tighten the summary" }, { approvalSurface: event.sender });
  await expect(decide(WORK_BOARD.decideJoin, event, 7, joinInput)).resolves.toEqual({ ok: true });
  expect(engine.decideStageJoin).toHaveBeenCalledWith(7, joinInput, { approvalSurface: event.sender });
  await expect(decide(WORK_BOARD.retryStage, event, 7, retryInput)).resolves.toEqual({ ok: true });
  expect(engine.retryStage).toHaveBeenCalledWith(7, retryInput, { approvalSurface: event.sender });
  expect(log).toHaveBeenCalledTimes(3);
  const logged = log.mock.calls.map(call => (call[0] as { output: string; type: string; sessionId: string }));
  for (const entry of logged) {
    expect(entry).toMatchObject({ type: "approval", sessionId: "work-board:7" });
    expect(JSON.parse(entry.output)).toMatchObject({ event: "work-approval:stage-decided", origin: "local-desktop", runId: RUN });
    expect(entry.output).not.toContain("tighten");
  }
});

it("refuses a malformed or partial decision before the engine sees it", async () => {
  const { event, engine, log } = setup();
  const bad: [WorkBoardDecisionChannel, unknown][] = [
    [WORK_BOARD.decideStage, { ...gateInput, attempt: 4 }],
    [WORK_BOARD.decideStage, { ...gateInput, resultHash: "short" }],
    [WORK_BOARD.decideStage, { ...gateInput, stageId: "Not A Stage" }],
    [WORK_BOARD.decideStage, { ...gateInput, decision: "retry" }],
    [WORK_BOARD.decideStage, { ...gateInput, output: "the renderer's own text" }],
    [WORK_BOARD.decideStage, { runId: RUN, stageId: "a" }],
    [WORK_BOARD.decideJoin, { ...joinInput, decision: "approve" }],
    [WORK_BOARD.decideJoin, { ...joinInput, conflictHash: 5 }],
    [WORK_BOARD.retryStage, { ...retryInput, attempt: 2 }],
    [WORK_BOARD.retryStage, "a"],
  ];
  for (const [channel, input] of bad) await expect(decide(channel, event, 7, input)).resolves.toEqual({ ok: false, reason: "invalid-input" });
  await expect(decide(WORK_BOARD.decideStage, event, 7, { ...gateInput, note: "x".repeat(MAX_PLAN_NOTE_LENGTH + 1) })).resolves.toEqual({ ok: false, reason: "note_too_long" });
  await expect(decide(WORK_BOARD.decideStage, event, 8, gateInput)).resolves.toEqual({ ok: false, reason: "not_found" });
  await expect(decide(WORK_BOARD.decideStage, event, "7", gateInput)).resolves.toEqual({ ok: false, reason: "invalid-input" });
  expect(engine.decideStageGate).not.toHaveBeenCalled();
  expect(engine.decideStageJoin).not.toHaveBeenCalled();
  expect(engine.retryStage).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it("redacts the note before the engine stores it and reports the count", async () => {
  const { event, engine } = setup({ piiRedactEnabled: true });
  const result = await decide(WORK_BOARD.decideStage, event, 7, { ...gateInput, decision: "request_changes", note: "mail someone@example.com" });
  const sent = (engine.decideStageGate.mock.calls[0] as unknown as [number, { note: string }])[1];
  expect(sent.note).not.toContain("someone@example.com");
  expect(result).toEqual({ ok: true, status: "approved", redactedCount: 1 });
});

it("starts a template run only from a gesture and the tuple the card showed, and mints the source itself", async () => {
  const { event, engine } = setup();
  const run = handler(WORK_BOARD.run);
  await expect(run(event, 7, { template: TUPLE })).resolves.toMatchObject({ status: "error", reasonCode: "user-gesture-required" });
  await expect(run(event, 7, { template: TUPLE }, { inputOrigin: "user-keyboard", userActivation: false })).resolves.toMatchObject({ status: "error", reasonCode: "user-gesture-required" });
  await expect(run(event, 7, { template: null }, GESTURE)).resolves.toMatchObject({ status: "error", reasonCode: "invalid-input" });
  await expect(run(event, 7, { template: { ...TUPLE, graphHash: "nope" } }, GESTURE)).resolves.toMatchObject({ status: "error", reasonCode: "invalid-input" });
  // A source object in the payload is not a tuple; nothing a renderer sends becomes the source.
  await expect(run(event, 7, { template: { ...TUPLE, kind: "schedule-attachment", attachmentId: "att-1" } }, GESTURE)).resolves.toMatchObject({ status: "error", reasonCode: "invalid-input" });
  await expect(run(event, 7, { template: TUPLE, templateSource: { kind: "schedule-attachment", attachmentId: "att-1", pin: TUPLE } }, GESTURE)).resolves.toEqual({ status: "awaiting_approval" });
  expect(engine.runItem).toHaveBeenCalledTimes(1);
  expect(engine.runItem).toHaveBeenCalledWith(7, { approvalSurface: event.sender, templateSource: { kind: "local-create-and-run", pin: TUPLE } });
});

it("leaves an ordinary run as it was: no gesture, no source", async () => {
  const { event, engine } = setup();
  await expect(handler(WORK_BOARD.run)(event, 9, { agentName: "helper", templateSource: { kind: "local-create-and-run", pin: TUPLE } })).resolves.toEqual({ status: "awaiting_approval" });
  expect(engine.runItem).toHaveBeenCalledWith(9, { agentName: "helper", approvalSurface: event.sender });
});

it("steers a template run by the exact stage shape and never lets any other argument reach the engine", async () => {
  const { event, engine } = setup();
  await expect(handler(WORK_BOARD.steerRun)(event, 7, "go", GESTURE, { stageId: "b" })).resolves.toEqual({ ok: true, messageId: "m-1" });
  expect(engine.steerRun).toHaveBeenLastCalledWith(7, "go", "b");
  for (const forged of ["b", { stageId: "sub-Forged Child" }, { stageId: "b", childSessionId: "child-9" }, null, ["b"]]) {
    await expect(handler(WORK_BOARD.steerRun)(event, 9, "go", GESTURE, forged)).resolves.toEqual({ ok: true, messageId: "m-1" });
    expect(engine.steerRun).toHaveBeenLastCalledWith(9, "go");
  }
});

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
const conflict = { integrate: () => ({ ok: false as const, conflict: { conflictHash: "c".repeat(64), reason: "merge-conflict" as const, files: [] } }) };
async function awaiting(h: Harness, finish: Parameters<Harness["children"][number]["finish"]>[0] = {}, stages = [stageOf("a")]) {
  const version = await h.confirm(stages);
  const id = await h.addItem(version);
  const run = h.start(id, h.local(version));
  (await h.untilLive(1))[0].finish(finish);
  await run;
  return { id, item: await h.item(id) };
}

// The engine's own writes behind a stage decision and a template run's start go through the same copy as every board write.
it.each<[string, string, Parameters<typeof stageRunHarness>[0], (h: Harness) => Promise<[string, unknown[]]>]>([
  ["a stage gate's decision", "workflow-runs.json", {}, async h => {
    const { id, item } = await awaiting(h);
    const stage = await h.stageRun(id, "a");
    return [WORK_BOARD.decideStage, [id, { runId: item.runId, stageId: "a", attempt: stage.attempt, resultHash: stage.resultHash, decision: "approve" }, GESTURE]];
  }],
  ["a failed stage's retry", "workflow-runs.json", {}, async h => {
    const { id, item } = await awaiting(h, { ok: false, summary: "failed", error: "failed" });
    return [WORK_BOARD.retryStage, [id, { runId: item.runId, stageId: "a" }, GESTURE]];
  }],
  ["a join decision", "workflow-runs.json", conflict, async h => {
    const { id, item } = await awaiting(h, {}, [autoStageOf("a")]);
    const [join] = item.stageJoins;
    return [WORK_BOARD.decideJoin, [id, { runId: item.runId, joinId: join.joinId, conflictHash: join.conflict?.conflictHash, decision: "retry_merge" }, GESTURE]];
  }],
  ["a template run's start", "workflow-runs.json", {}, async h => {
    const version = await h.confirm([stageOf("a")]);
    return [WORK_BOARD.run, [await h.addItem(version), { template: h.pinOf(version) }, GESTURE]];
  }],
])("answers %s with work-board-backup-failed, never a raw failure, and leaves both files as they were", async (_, file, opts, prepare) => {
  const h = await stageRunHarness(opts);
  try {
    const owner = workBoardTestSender();
    const window = { isDestroyed: () => false, webContents: owner };
    registerWorkBoardHandlers({ workBoardStore: h.board, workBoardEngine: h.engine, auditLogger: { log: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window] } as unknown as IpcDeps);
    const [channel, args] = await prepare(h);
    const files = [h.boardPath, join(h.dir, "workflow-runs.json")];
    for (const written of files) writeFileSync(written, JSON.stringify(JSON.parse(readFileSync(written, "utf8"))));
    const before = files.map(written => readFileSync(written));
    const kept = () => readdirSync(h.dir).filter(name => name.endsWith(".bak"));
    const keptBefore = kept();
    const write = namespace.writeFileAtomicAtPath;
    const copies: string[] = [];
    vi.spyOn(namespace, "writeFileAtomicAtPath").mockImplementation(async (target, body) => {
      if (!target.endsWith(".bak")) return write(target, body);
      copies.push(target);
      throw Object.assign(new Error("EACCES: permission denied, open 'C:\\private'"), { code: "EACCES" });
    });
    try {
      const event = { sender: owner, senderFrame: owner.mainFrame };
      const answer = channel === WORK_BOARD.run
        ? await handler(channel)(event, ...args)
        : await decide(channel as WorkBoardDecisionChannel, event, args[0], args[1]);
      expect(answer).toEqual(channel === WORK_BOARD.run ? { status: "error", reason: "work-board-backup-failed", reasonCode: "work-board-backup-failed" } : { ok: false, reason: "work-board-backup-failed" });
      expect(JSON.stringify(answer)).not.toMatch(/EACCES|private/);
      expect([...new Set(copies.map(copy => copy.slice(h.dir.length + 1).split(".").slice(0, 2).join(".")))]).toEqual([file]);
      expect(files.map(written => readFileSync(written))).toEqual(before);
      expect(kept()).toEqual(keptBefore);
    } finally { vi.restoreAllMocks(); }
  } finally { for (const child of h.children) child.finish(); await h.cleanup(); }
});

it("projects a parked result on get and list, then refuses the superseded snapshot at the host", async () => {
  const h = await stageRunHarness({});
  try {
    const privatePath = ["", "Users", "demo", "Documents", "report.md"].join("/");
    const rawResult = `First review result at ${privatePath}`;
    const { id, item } = await awaiting(h, { summary: rawResult });
    const audit = new AuditLogger(join(h.dir, "audit"));
    const owner = workBoardTestSender();
    const window = { isDestroyed: () => false, webContents: owner };
    registerWorkBoardHandlers({ workBoardStore: h.board, workBoardEngine: h.engine, settingsService: { get: () => undefined }, auditLogger: audit, getMainWindow: () => window, getAppWindows: () => [window] } as unknown as IpcDeps);
    const event = { sender: owner, senderFrame: owner.mainFrame };
    const stage = item.stageRuns[0];
    const binding = { runId: item.runId, stageId: "a", attempt: 1, resultHash: stage.resultHash };
    const expected = { runPin: item.record?.pin, pendingWorkflowDecisions: [{ kind: "stage-gate", binding, result: expect.stringContaining("First review result at ") }] };
    registerWorkApprovalsHandlers({
      workBoardStore: h.board, workBoardEngine: h.engine, routinesStore: { list: () => [], listInvalid: () => [] }, auditLogger: audit,
    } as unknown as IpcDeps);
    await expect(handler(WORK_APPROVALS.list)(event, { allProjects: true })).resolves.toMatchObject({
      ok: true, total: 1, items: [{ ...expected.pendingWorkflowDecisions[0], itemId: id }],
    });
    await bindDefaultProject(event);
    expect(binding.resultHash).toBe(resultHashOf(rawResult));
    const got = await handler(WORK_BOARD.get)(event, id);
    expect(JSON.stringify(got)).not.toContain(privatePath);
    expect(got).toMatchObject({ item: { ...expected, workflowRun: { stages: [{ stageId: "a", status: "awaiting_gate" }] } } });
    await expect(handler(WORK_BOARD.list)(event)).resolves.toMatchObject({ items: [expected] });
    expect(h.events).toContainEqual(expect.objectContaining({ workflowRun: expect.objectContaining({ stages: [expect.objectContaining({ stageId: "a", status: "awaiting_gate" })] }) }));
    await expect(decide(WORK_BOARD.decideStage, event, id, { ...binding, decision: "request_changes", note: "Revise the result" })).resolves.toMatchObject({ ok: true });
    (await h.untilLive(1))[0].finish({ summary: "Revised review result" });
    const revised = await h.until(id, view => view.stageRuns[0]?.attempt === 2 && view.stageRuns[0]?.status === "awaiting_gate");
    await expect(decide(WORK_BOARD.decideStage, event, id, { ...binding, decision: "approve" })).resolves.toEqual({ ok: false, reason: "attempt_mismatch" });
    await expect(decide(WORK_BOARD.decideStage, event, id, { ...binding, attempt: 2, decision: "approve" })).resolves.toEqual({ ok: false, reason: "result_mismatch" });
    expect((await h.item(id)).stageRuns).toEqual(revised.stageRuns);
    await expect(handler(WORK_BOARD.get)(event, id)).resolves.toMatchObject({
      item: { workflowRun: { decisions: [{ kind: "stage-gate", stageId: "a", attempt: 1, decision: "request_changes" }] } },
    });
  } finally { for (const child of h.children) child.finish(); await h.cleanup(); }
});


it("projects join conflict evidence and refuses the previous conflict hash after a retry", async () => {
  const files = [{ path: "reports/summary.md", stageIds: ["a"] }];
  const h = await stageRunHarness({
    integrate: () => ({ ok: false, conflict: { reason: "same-path", files, conflictHash: "c".repeat(64) } }),
  });
  try {
    const { id, item } = await awaiting(h, {}, [autoStageOf("a")]);
    const owner = workBoardTestSender();
    const window = { isDestroyed: () => false, webContents: owner };
    const deps = {
      workBoardStore: h.board, workBoardEngine: h.engine, routinesStore: { list: () => [], listInvalid: () => [] },
      auditLogger: { log: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window],
    } as unknown as IpcDeps;
    registerWorkBoardHandlers(deps);
    registerWorkApprovalsHandlers(deps);
    const event = { sender: owner, senderFrame: owner.mainFrame };
    await bindDefaultProject(event);
    const binding = { runId: item.runId, joinId: item.stageJoins[0].joinId, conflictHash: item.stageJoins[0].conflict?.conflictHash };
    const review = { kind: "join-conflict", generation: 1, binding, evidence: { reason: "same-path", files } };
    await expect(handler(WORK_BOARD.get)(event, id)).resolves.toMatchObject({ item: { pendingWorkflowDecisions: [review] } });
    await expect(handler(WORK_APPROVALS.list)(event, { allProjects: true })).resolves.toMatchObject({ total: 1, items: [review] });
    await expect(decide(WORK_BOARD.decideJoin, event, id, { ...binding, decision: "retry_merge" })).resolves.toEqual({ ok: true });
    const changed = await h.until(id, view => view.stageJoins[0]?.status === "conflict" && view.stageJoins[0].decidedAt !== undefined);
    expect(changed.stageJoins[0].conflictGeneration).toBe(2);
    expect(changed.stageJoins[0].conflict?.conflictHash).not.toBe(binding.conflictHash);
    await expect(decide(WORK_BOARD.decideJoin, event, id, { ...binding, decision: "reject" })).resolves.toEqual({ ok: false, reason: "conflict_mismatch" });
    expect((await h.item(id)).stageJoins).toEqual(changed.stageJoins);
    await expect(handler(WORK_BOARD.get)(event, id)).resolves.toMatchObject({
      item: { workflowRun: { decisions: [{ kind: "join-conflict", joinId: binding.joinId, decision: "retry_merge" }] } },
    });
  } finally { for (const child of h.children) child.finish(); await h.cleanup(); }
});


it("shows stored delegation edges only for the parent session of this legacy item", async () => {
  const get = vi.fn(async (id: number) => ({
    status: "found", item: { id, runSessionId: "parent-run", title: "Legacy work", status: "in_progress", status_resolved: "in_progress" },
  }));
  const listPersistedSpawnsForOrigin = vi.fn(() => [{ childSessionId: "delegated-run", title: "Verify results" }]);
  const isPersistedSpawnOfOrigin = vi.fn((origin: string, child: string) => origin === workBoardOriginSessionId(7) && child === "parent-run");
  const owner = workBoardTestSender();
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const window = { isDestroyed: () => false, webContents: owner };
  registerWorkBoardHandlers({
    workBoardStore: { get },
    getSubAgentRunner: () => ({ isPersistedSpawnOfOrigin, listPersistedSpawnsForOrigin }),
    auditLogger: { log: vi.fn() }, getMainWindow: () => window,
  } as unknown as IpcDeps);
  await bindDefaultProject(event);
  await expect(handler(WORK_BOARD.get)(event, 7)).resolves.toMatchObject({
    item: { delegatedSessions: [{ parentSessionId: "parent-run", childSessionId: "delegated-run", title: "Verify results" }] },
  });
  const other = await handler(WORK_BOARD.get)(event, 8);
  expect(other).not.toHaveProperty("item.delegatedSessions");
  expect(listPersistedSpawnsForOrigin).toHaveBeenCalledExactlyOnceWith("parent-run");
});

it.each([
  [WORK_BOARD.decidePlan, { runId: RUN, planHash: HASH, decision: "approve" }],
  [WORK_BOARD.decideStage, gateInput],
  [WORK_BOARD.decideJoin, joinInput],
  [WORK_BOARD.retryStage, retryInput],
] as const)("spends a native token once and binds its card and action for %s", async (channel, input) => {
  const { event } = setup();
  const invoke = handler(channel);
  const refusal = { ok: false, reason: "user-gesture-required" };
  const token = await captureWorkBoardTestGesture(handler, event, channel, 7, input);
  await expect(invoke(event, 7, input, token)).resolves.toMatchObject({ ok: true });
  await expect(invoke(event, 7, input, token)).resolves.toEqual(refusal);

  const anotherCard = await captureWorkBoardTestGesture(handler, event, channel, 7, input);
  await expect(invoke(event, 9, input, anotherCard)).resolves.toEqual(refusal);
  await expect(invoke(event, 7, input, anotherCard)).resolves.toEqual(refusal);
  if ("decision" in input) {
    const wrongAction = await captureWorkBoardTestGesture(handler, event, channel, 7, input);
    await expect(invoke(event, 7, { ...input, decision: "reject" }, wrongAction)).resolves.toEqual(refusal);
  }
  expect(await handler(WORK_BOARD.captureDecisionIntent)(event, token, workBoardDecisionKey(channel, 7, input))).toBe(false);
});

it("refuses an expired decision receipt even when it was valid at capture", async () => {
  const { event } = setup();
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(1_000);
    const token = await captureWorkBoardTestGesture(handler, event, WORK_BOARD.decideStage, 7, gateInput);
    now.mockReturnValue(6_001);
    await expect(handler(WORK_BOARD.decideStage)(event, 7, gateInput, token)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
  } finally { now.mockRestore(); }
});

it("scopes stage progress and get to each window's current authorized project", async () => {
  const ownerA = workBoardTestSender();
  const ownerB = workBoardTestSender();
  const eventA = { sender: ownerA, senderFrame: ownerA.mainFrame };
  const eventB = { sender: ownerB, senderFrame: ownerB.mainFrame };
  const windows = [ownerA, ownerB].map(webContents => ({ webContents, isDestroyed: () => false })) as unknown as MainWindow[];
  const h = await stageRunHarness({
    onProgress: (event, project) => {
      if (project) deliverWorkBoardProgress(windows, event, project.projectRoot);
    },
  });
  const settings = permissionSettings.readPermissionSettings();
  const projectSettings = vi.spyOn(permissionSettings, "readPermissionSettings");
  try {
    const rootA = join(h.dir, "project-a");
    const rootB = join(h.dir, "project-b");
    mkdirSync(rootA);
    mkdirSync(rootB);
    projectSettings.mockReturnValue({ ...settings, permissions: { ...settings.permissions, additionalDirectories: [rootA, rootB] } });
    const deps = {
      workBoardStore: h.board, workBoardEngine: h.engine, routinesStore: { list: () => [], listInvalid: () => [] },
      auditLogger: { log: vi.fn() }, getMainWindow: () => windows[0], getAppWindows: () => windows,
    } as unknown as IpcDeps;
    registerWorkBoardHandlers(deps);
    registerWorkApprovalsHandlers(deps);
    expect(await handler(WORK_BOARD.setProjectScope)(eventA, rootA)).toBe(true);
    expect(await handler(WORK_BOARD.setProjectScope)(eventB, rootB)).toBe(true);
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version, rootA);
    const started = h.start(id, h.local(version, rootA));
    const [child] = await h.untilLive(1);
    await h.until(id, row => row.stageRuns[0]?.childSessionId === child.sessionId);
    child.reportActivity({ toolCallCount: 0, entries: [{ kind: "assistant", text: "Project A turn" }] });
    child.finish({ summary: "Project A private stage result" });
    await started;
    const evidence = (owner: typeof ownerA) => JSON.stringify(owner.send.mock.calls.filter(([channel]) => channel === WORK_BOARD.runProgress));
    expect(evidence(ownerA)).toContain("Project A turn");
    expect(evidence(ownerA)).toContain("Project A private stage result");
    expect(evidence(ownerB)).not.toContain("Project A");
    expect(await handler(WORK_BOARD.get)(eventA, id)).toMatchObject({
      item: { workflowRun: { stages: [{ result: "Project A private stage result" }] } },
    });
    await expect(handler(WORK_BOARD.get)(eventB, id)).resolves.toEqual({ status: "not_found", itemId: id });
    await expect(handler(WORK_BOARD.list)(eventA, { projectRoot: rootA })).resolves.toMatchObject({ items: [{ id, workflowRunPins: [{ pin: h.pinOf(version) }] }] });
    await expect(handler(WORK_BOARD.list)(eventA)).resolves.toMatchObject({ items: [] });
    await expect(handler(WORK_APPROVALS.list)(eventB, { projectRoot: rootB })).resolves.toMatchObject({ ok: true, items: [] });
    await expect(handler(WORK_APPROVALS.list)(eventB, { allProjects: true })).resolves.toMatchObject({
      ok: true, items: [{ result: "Project A private stage result" }],
    });
    expect(await handler(WORK_BOARD.setProjectScope)(eventA, rootB)).toBe(true);
    await expect(handler(WORK_BOARD.get)(eventA, id)).resolves.toEqual({ status: "not_found", itemId: id });
  } finally {
    projectSettings.mockRestore();
    for (const child of h.children) child.finish();
    await h.cleanup();
  }
});

it("reads Work Approvals without confirming a failed settle or releasing its workspace", async () => {
  const released = vi.fn(async () => {});
  const h = await stageRunHarness({ workspace: { release: released }, observeRunWork: true });
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const started = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    const { runId } = await h.until(id, item => item.stageRuns[0]?.childSessionId !== undefined);
    if (!runId) throw new Error("Missing workflow run");
    const update = vi.spyOn(h.board, "updateRun").mockResolvedValue({ status: "pending-review" });
    child.finish();
    await started;
    update.mockRestore();
    await h.drainRunWork();
    const runsFile = join(h.dir, "workflow-runs.json");
    const before = readFileSync(runsFile);
    registerWorkApprovalsHandlers({
      workBoardStore: h.board, workBoardEngine: h.engine, routinesStore: { list: () => [], listInvalid: () => [] },
      auditLogger: { log: vi.fn() },
    } as unknown as IpcDeps);
    await expect(handler(WORK_APPROVALS.list)({}, { allProjects: true })).resolves.toMatchObject({ ok: true, items: [] });
    await h.drainRunWork();
    expect(readFileSync(runsFile)).toEqual(before);
    expect(released).not.toHaveBeenCalled();
    await h.engine.adoptParkedTemplateRuns();
    expect((await h.runOf(runId))?.settled).toBeDefined();
    expect(released).toHaveBeenCalledTimes(1);
  } finally { for (const child of h.children) child.finish(); await h.cleanup(); }
});

it("opens only the current conflict's host-owned join folder with a fresh receipt", async () => {
  const openPath = vi.mocked(shell.openPath);
  openPath.mockClear();
  let workspacesRoot: string;
  const joinFolder = vi.fn(async (run: { runId: string }, open: (path: string) => Promise<boolean>) => open(join(workspacesRoot, run.runId, "_join")));
  const h = await stageRunHarness({
    integrate: () => ({ ok: false, conflict: { conflictHash: HASH, reason: "merge-conflict", files: [] } }),
    workspace: {
      open: async run => ({ ok: true, workspace: { kind: "git", runRoot: join(workspacesRoot, run.runId) } }),
      openJoinFolder: joinFolder,
    },
  });
  workspacesRoot = join(h.dir, "runs");
  try {
    const projectRoot = defaultWorkspaceProject().projectRoot;
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version, projectRoot);
    const started = h.start(id, h.local(version, projectRoot));
    (await h.untilLive(1))[0].finish();
    await started;
    const row = await h.item(id);
    const conflict = row.stageJoins[0];
    const input = { runId: row.runId, joinId: conflict.joinId, conflictHash: conflict.conflict?.conflictHash };
    const owner = workBoardTestSender();
    const event = { sender: owner, senderFrame: owner.mainFrame };
    const window = { webContents: owner, isDestroyed: () => false };
    registerWorkBoardHandlers({ workBoardStore: h.board, workBoardEngine: h.engine, auditLogger: { log: vi.fn() },
      getMainWindow: () => window, getAppWindows: () => [window] } as unknown as IpcDeps);
    await expect(handler(WORK_BOARD.openJoin)(event, id, input)).resolves.toEqual({ ok: false, reason: "user-gesture-required" });
    await expect(decide(WORK_BOARD.openJoin, event, id, { ...input, path: "other" })).resolves.toEqual({ ok: false, reason: "invalid-input" });
    await expect(decide(WORK_BOARD.openJoin, event, id, { ...input, conflictHash: "b".repeat(64) })).resolves.toEqual({ ok: false, reason: "conflict_mismatch" });
    expect(openPath).not.toHaveBeenCalled();
    await expect(decide(WORK_BOARD.openJoin, event, id, input)).resolves.toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(join(workspacesRoot, row.runId ?? "", "_join"));
  } finally { for (const child of h.children) child.finish(); await h.cleanup(); }
});
