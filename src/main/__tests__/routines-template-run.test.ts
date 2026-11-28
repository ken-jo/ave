import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi, onTestFinished } from "vitest";
import { collectPermissionEvents } from "../../__tests__/support/permission-events.js";
import { workflowEngineExtensions } from "../../boot/steps/workflow-engine-extensions.js";
import { createToolEffectResolver } from "../../permissions/tool-effect-evidence.js";
import type { TemplateScope, TemplateVersion } from "../../shared/workflow-template-types.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createRoutineScheduleTool } from "../../tools/routine-schedule.js";
import { createStageWorkspaceProvider } from "../../work-board/workflow/stage-workspaces.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { untilAsserted } from "../../__tests__/support/signal-wait.js";
import { autoStageOf, runScopePermissions, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness, unavailableOutputAdapter } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { mayFire } from "../../work-board/workflow/schedule-breaker.js";
import { RoutinesScheduler } from "../routines-scheduler.js";
import { RoutinesStore, removeRoutineWithRuns, type TemplateRoutineFire } from "../routines-store.js";
import { mintHostDecisionProof } from "../workflow-template-decision.js";
import { futureIso, pastIso } from "./routines-fixture.js";
import { t } from "../../i18n/index.js";

const proof = () => mintHostDecisionProof("local-desktop");
const project = (projectRoot: string): TemplateScope => ({ kind: "project", projectRoot });
const owner = { createdBy: "user", projectRoot: "/project/a" } as const;
const input = (at = futureIso()) => ({ ...owner, trigger: "schedule", execution: "template-run", title: "Report", schedule: { at, repeat: { kind: "daily" } } }) as const;

async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options?: Parameters<typeof stageRunHarness>[0]) {
  const h = await stageRunHarness({ observeRunWork: true, ...options });
  await h.runThenEnd(async () => body(await setup(h)));
}

async function setup(h: Awaited<ReturnType<typeof stageRunHarness>>) {
  const capture = collectPermissionEvents();
  onTestFinished(capture.restore);
  const path = join(h.dir, "routines.json");
  const store = new RoutinesStore(path);
  store.bindTemplateAttachments(h.templates);
  const scheduler = new RoutinesScheduler(store, async () => []);
  const dispatches: Promise<void>[] = [];
  const { fireScheduledTemplate } = await import("../routines-template-run.js");
  const fire = (event: TemplateRoutineFire) => fireScheduledTemplate({
    routinesStore: store, workflowTemplateStore: h.templates, workBoardStore: h.board, workBoardEngine: h.engine,
  }, event, mayFire);
  scheduler.onTemplateRun(event => { dispatches.push(fire(event)); });
  const add = (at?: string) => store.add(input(at), proof());
  const attach = (scheduleId: string, version: TemplateVersion, scope: TemplateScope = { kind: "all" }) =>
    store.withTemplateSchedule(scheduleId, () => h.templates.attachSchedule({ scheduleId, ...h.pinOf(version) }, proof(), scope));
  const takeDispatch = () => {
    const result = dispatches.shift();
    if (!result) throw new Error("Missing template scheduler dispatch");
    return { result };
  };
  const dispatch = async (id: string) => {
    expect(await scheduler.dispatchNow(id)).toBe(true);
    return takeDispatch();
  };
  const poll = async () => {
    await scheduler.checkAndFire();
    return takeDispatch();
  };
  const rows = async () => {
    const listed = await h.board.list();
    if (listed.status !== "ok") throw new Error("Board list refused");
    return listed.items;
  };
  return { h, path, store, add, attach, dispatch, poll, rows, events: capture.events };
}

it("the store refuses the kind without the attach proof", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    const store = new RoutinesStore(join(h.dir, "routines.json"));
    store.bindTemplateAttachments(h.templates);
    await expect(store.add(input())).rejects.toMatchObject({ code: "invalid-input" });
    await expect(store.add(input(), { origin: "local-desktop" } as never)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(store.add(input(), { origin: "tailnet-surface" } as never)).rejects.toMatchObject({ code: "invalid-input" });
    const routine = await store.add(input(), proof());
    await expect(store.edit(routine.id, { title: "Changed" })).rejects.toMatchObject({ code: "invalid-input" });
    expect(store.list()).toEqual([expect.objectContaining({ title: "Report" })]);
  });
});

it("the routine tool cannot create or edit a template-run routine and its removal refusal names detach", () => fixture(async f => {
  const routine = await f.add();
  const version = await f.h.confirm([autoStageOf("first")]);
  await f.attach(routine.id, version);
  const removeRoutine = vi.fn((id: string) => f.store.remove(id));
  const tool = createRoutineScheduleTool(f.store, { projectRootForSession: () => owner.projectRoot, chatForSession: () => "session", removeRoutine });
  const context = { metadata: { sessionId: "session" } } as Parameters<typeof tool.execute>[1];
  for (const request of [
    { execution: "template-run", schedule: input().schedule },
    { execution: "notification-only", schedule: input().schedule, notificationTitle: "Report", attachmentId: "forged" },
    { action: "update", routineId: routine.id, title: "Changed" },
  ]) {
    const result = await tool.execute(request, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ error: t("reasonCodes.template-schedule-local-approval") });
  }
  const denied = await tool.execute({ action: "remove", routineId: routine.id }, context);
  expect(denied.isError).toBe(true);
  expect(JSON.parse(denied.output)).toEqual({ error: t("reasonCodes.detach-template-schedule-first") });
  expect(removeRoutine).not.toHaveBeenCalled();
  await expect(removeRoutineWithRuns({ routinesStore: f.store, memoryManager: { sessions: { listSessionsByRoutine: vi.fn(() => []), deleteSession: vi.fn() } }, endSessionScope: vi.fn() }, routine.id)).rejects.toThrow(/detach/i);
  expect(f.store.list()).toHaveLength(1);
  expect(await f.h.templates.listByRoutine(routine.id)).toEqual([expect.objectContaining({ version: 1 })]);
}));

it("a template-run routine with no active attachment is removed by the ordinary path", () => fixture(async f => {
  const routine = await f.add();
  expect(await f.store.remove(routine.id)).toBe(true);
  expect(f.store.list()).toEqual([]);
}));

it("the routine tool directs an orphan schedule to desktop removal", () => fixture(async f => {
  const routine = await f.add();
  const removeRoutine = vi.fn((id: string) => f.store.remove(id));
  const tool = createRoutineScheduleTool(f.store, { projectRootForSession: () => owner.projectRoot, chatForSession: () => "session", removeRoutine });
  const context = { metadata: { sessionId: "session" } } as Parameters<typeof tool.execute>[1];
  const denied = await tool.execute({ action: "remove", routineId: routine.id }, context);
  expect(denied.isError).toBe(true);
  expect(JSON.parse(denied.output)).toEqual({ error: t("be_routineSchedule.orphanTemplateRemove") });
  expect(removeRoutine).not.toHaveBeenCalled();
  expect(f.store.list().map(record => record.id)).toEqual([routine.id]);
}));

it("a fire starts the attachment's version while a newer one is current", () => fixture(async f => {
  const routine = await f.add(pastIso());
  const v1 = await f.h.confirm([autoStageOf("first")]);
  const attached = await f.attach(routine.id, v1);
  await f.h.confirm([autoStageOf("second")], { id: v1.templateId });
  const { result } = await f.poll();
  const [child] = await f.h.untilLive(1);
  expect(child.input.unattendedStage).toMatchObject({ stageId: "first" });
  const [row] = await f.rows();
  expect((await f.h.item(row.id)).record).toMatchObject({ pin: f.h.pinOf(v1), runStartedBy: { attachmentId: attached.id } });
  child.finish();
  await result;
  expect(await f.h.templates.listByRoutine(routine.id)).toEqual([attached]);
}));

it("a detached schedule refuses to fire and an orphan is listed as needs reattach or delete without repair", () => fixture(async f => {
  const routine = await f.add();
  const version = await f.h.confirm([autoStageOf("first")]);
  const attachment = await f.attach(routine.id, version);
  await f.h.detach(attachment.id);
  const reloaded = new RoutinesStore(f.path);
  reloaded.bindTemplateAttachments(f.h.templates);
  await reloaded.load();
  expect((await reloaded.listScheduleDisplay()).routines).toEqual([expect.objectContaining({ templateAttention: "attachment-missing" })]);
  await (await f.dispatch(routine.id)).result;
  expect(f.store.list()[0].lastFailure).toMatchObject({ reason: "attachment-missing" });
  expect((await f.store.listScheduleDisplay()).routines[0].templateAttention).toBe("attachment-missing");
  expect(await f.rows()).toEqual([]);
  expect(await f.h.templates.listByRoutine(routine.id)).toEqual([expect.objectContaining({ id: attachment.id, detachedAt: expect.any(String) })]);
}));

it("a refused start records scope-changed, creates no item and lists the schedule as needs reattach", () => fixture(async f => {
  const routine = await f.add();
  const v1 = await f.h.confirm([autoStageOf("first")], { scope: project("/project/a") });
  const attachment = await f.attach(routine.id, v1, project("/project/a"));
  await f.h.confirm([autoStageOf("second")], { id: v1.templateId, scope: project("/project/b") });
  await (await f.dispatch(routine.id)).result;
  expect(f.store.list()[0].lastFailure).toMatchObject({ reason: "scope-changed" });
  expect((await f.store.listScheduleDisplay()).routines[0]).toMatchObject({ attachmentId: attachment.id, templateAttention: "scope-changed" });
  expect(await f.rows()).toEqual([]);
  expect(f.h.children).toEqual([]);
  expect(await f.h.templates.listByRoutine(routine.id)).toEqual([attachment]);
}));

it("a fire whose snapshot matches runs on the snapshot's project", () => fixture(async f => {
  const routine = await f.add();
  const scope = project("/project/b");
  const version = await f.h.confirm([autoStageOf("first")], { scope });
  await f.attach(routine.id, version, scope);
  const { result } = await f.dispatch(routine.id);
  const [child] = await f.h.untilLive(1);
  expect((await f.rows())[0].projectRoot).toBe("/project/b");
  child.finish();
  await result;
}));

it("a stale attachment to a non-read-only version loads alongside other templates and refuses the fire", () => fixture(async f => {
  const routine = await f.add();
  const v1 = await f.h.confirm([autoStageOf("first")]);
  await f.attach(routine.id, v1);
  const v2 = await f.h.confirm([autoStageOf("write", { toolScope: "all" })], { id: v1.templateId });
  const other = await f.h.confirm([autoStageOf("second")]);
  const path = join(f.h.dir, "templates.json");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  Object.assign(persisted.templates.find((record: { template: { id: string } }) => record.template.id === v1.templateId).scheduleAttachments[0], f.h.pinOf(v2));
  await writeFile(path, JSON.stringify(persisted));
  expect(await f.h.templates.get(other.templateId)).toMatchObject({ template: { id: other.templateId } });
  await (await f.dispatch(routine.id)).result;
  expect(f.store.list()[0].lastFailure).toMatchObject({ reason: "unattended-not-read-only" });
  expect(await f.rows()).toEqual([]);
}));

it.each(["outward-effect-tool", "tool-effect-unknown"] as const)("Q6 skips a refused fire with tool and code %s and asks again on the next fire", async code => {
  const tool = { stageId: "first", collection: "mcpReadOnlyTools", name: "lookup" } as const;
  let available = false;
  await fixture(async f => {
    const routine = await f.add();
    const version = await f.h.confirm([autoStageOf("first")]);
    const attachment = await f.attach(routine.id, version);
    await (await f.dispatch(routine.id)).result;
    expect((await f.store.listScheduleDisplay()).routines[0]).toMatchObject({ attachmentId: attachment.id, lastTemplateSkip: { code, tool } });
    expect(f.store.list()[0].templateAttention).toBeUndefined();
    expect(f.store.list()[0].lastFailure).toBeUndefined();
    expect(await f.rows()).toEqual([]);
    expect(await f.h.templates.listByRoutine(routine.id)).toEqual([attachment]);
    available = true;
    const { result } = await f.dispatch(routine.id);
    (await f.h.untilLive(1))[0].finish();
    await result;
    expect(f.store.list()[0].lastTemplateSkip).toBeUndefined();
  }, { workflow: { unattendedAllowed: () => available ? { ok: true } : { ok: false, code, tool } } });
});

it("two fires of one routine that arrive together start one run", () => fixture(async f => {
  const routine = await f.add();
  const version = await f.h.confirm([autoStageOf("first")]);
  await f.attach(routine.id, version);
  const [one, two] = await Promise.all([f.dispatch(routine.id), f.dispatch(routine.id)]);
  const [child] = await f.h.untilLive(1);
  await Promise.race([one.result, two.result]);
  expect(await f.rows()).toHaveLength(1);
  expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "run-unsettled" });
  child.finish();
  await Promise.all([one.result, two.result]);
  expect(f.h.children).toHaveLength(1);
}));

it("two failed stages park their runs and pause the routine across reload until the owner resumes it", () => fixture(async f => {
  const routine = await f.add();
  const version = await f.h.confirm([autoStageOf("report")]);
  const attachment = await f.attach(routine.id, version);
  const waitForReport = async (from: number) => {
    const started = await f.h.waitForProgress(event => event.stageId === "report" && event.runSessionId !== undefined, "report child", from);
    const child = f.h.children.find(candidate => candidate.sessionId === started.runSessionId);
    if (!child) throw new Error("Report child did not link");
    return child;
  };
  const failAndStop = async () => {
    const from = f.h.events.length;
    const fire = await f.dispatch(routine.id);
    const child = await waitForReport(from);
    child.finish({ ok: false, error: "Stage failed" });
    await fire.result;
    const row = (await f.rows()).find(item => item.runStatus === "executing");
    if (!row) throw new Error("Failed report did not park");
    expect(f.h.engine.cancelRun(row.id)).toMatchObject({ ok: true });
    await f.h.until(row.id, item => item.runStatus === "cancelled");
  };
  await failAndStop();
  await failAndStop();

  const reloaded = new RoutinesStore(f.path);
  reloaded.bindTemplateAttachments(f.h.templates);
  await reloaded.load();
  const [shown] = (await reloaded.listScheduleDisplay()).routines;
  expect(shown).toMatchObject({ attachmentId: attachment.id, pausedBy: "schedule-breaker", pausedAt: expect.any(String) });
  const scheduler = new RoutinesScheduler(reloaded, async () => []);
  expect(await scheduler.dispatchNow(routine.id)).toBe("paused");
  expect(f.h.children).toHaveLength(2);

  const replacement = await f.attach(routine.id, version);
  expect(await scheduler.dispatchNow(routine.id)).toBe("paused");
  expect((await f.store.resume(routine.id))?.pausedAt).toBeUndefined();
  const from = f.h.events.length;
  const fire = await f.dispatch(routine.id);
  (await waitForReport(from)).finish();
  await fire.result;
  expect(f.h.children).toHaveLength(3);
  expect((await f.store.listScheduleDisplay()).routines[0].attachmentId).toBe(replacement.id);
}));

it("two bad runs pause the schedule and a completed run resets the count", () => fixture(async f => {
  const routine = await f.add();
  await f.attach(routine.id, await f.h.confirm([autoStageOf("report")]));
  const first = await f.dispatch(routine.id);
  (await f.h.untilLive(1))[0].finish({ ok: false, error: "Stage failed" });
  await first.result;
  const [row] = await f.rows();
  if (!row.runId) throw new Error("Expected the parked run");
  expect(await f.h.engine.retryStage(row.id, { runId: row.runId, stageId: "report", attempt: 1 })).toEqual({ ok: true });
  (await f.h.untilLive(1, row.id))[0].finish();
  await f.h.until(row.id, item => item.runStatus === "completed");
  await untilAsserted(wake => f.store.changed.subscribe(wake), () => {
    expect(f.store.list()[0].lastFailure).toBeUndefined();
  }, "the same firing's completed retry to clear its failure");

  const from = f.h.events.length;
  const second = await f.dispatch(routine.id);
  const linked = await f.h.waitForProgress(event => event.stageId === "report" && event.runSessionId !== undefined, "the second scheduled child", from);
  const child = f.h.children.find(candidate => candidate.sessionId === linked.runSessionId);
  if (!child) throw new Error("Expected the second scheduled child");
  child.finish({ ok: false, error: "Stage failed again" });
  await second.result;
  expect(f.store.list()[0].pausedAt).toBeUndefined();
}));

it("the breaker uses the ordinary pause guard for a dismissed routine", () => fixture(async f => {
  const routine = await f.add();
  const outcomeAt = new Date(Date.now()).toISOString();
  await f.store.recordTemplateScheduleOutcome(routine.id, outcomeAt, "failed");
  await f.store.dismiss(routine.id);
  const secondAt = new Date(Date.parse(outcomeAt) + 1).toISOString();
  expect(await f.store.pause(routine.id, "user")).toBeNull();
  expect((await f.store.recordTemplateScheduleOutcome(routine.id, secondAt, "failed"))?.pausedAt).toBeUndefined();
}));

it("a post-link refusal does not count as an unavailable firing", async () => {
  const tool = { stageId: "second", collection: "mcpReadOnlyTools", name: "lookup" } as const;
  let available = false;
  await fixture(async f => {
    const routine = await f.add();
    const version = await f.h.confirm([autoStageOf("first"), autoStageOf("second", { inputs: ["first"] })]);
    await f.attach(routine.id, version);
    await (await f.dispatch(routine.id)).result;
    expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "tool-effect-unknown", tool });
    available = true;
    const linked = await f.dispatch(routine.id);
    const [first] = await f.h.untilLive(1);
    available = false;
    first.finish();
    await linked.result;
    expect(await f.rows()).toMatchObject([{ runStatus: "cancelled" }]);
    expect(f.store.list()[0]).toMatchObject({ lastFailure: { reason: "tool-effect-unknown" } });
    expect(f.store.list()[0].lastTemplateSkip).toBeUndefined();
    expect(f.store.list()[0].pausedAt).toBeUndefined();
    expect(f.h.children).toHaveLength(1);
    await (await f.dispatch(routine.id)).result;
    expect(f.store.list()[0].pausedBy).toBe("schedule-breaker");
  }, { workflow: { unattendedAllowed: () => available ? { ok: true } : { ok: false, code: "tool-effect-unknown", tool } } });
});

it("after a replacement attach a fire is skipped while the earlier attachment's run still has a live child, and that child is not interrupted", () => fixture(async f => {
  const routine = await f.add();
  const v1 = await f.h.confirm([stageOf("first"), autoStageOf("later", { inputs: ["first"] })]);
  await f.attach(routine.id, v1);
  const old = await f.dispatch(routine.id);
  const [child] = await f.h.untilLive(1);
  const v2 = await f.h.confirm([autoStageOf("new")], { id: v1.templateId });
  await f.attach(routine.id, v2);
  await (await f.dispatch(routine.id)).result;
  expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "run-unsettled" });
  expect(f.h.interrupts).toEqual([]);
  expect(await f.rows()).toHaveLength(1);
  child.finish();
  await old.result;
}));

it("a replacement fire leaves a parked gate pending, and once the earlier run settles the new attachment fires", () => fixture(async f => {
  const routine = await f.add();
  const v1 = await f.h.confirm([stageOf("first"), autoStageOf("later", { inputs: ["first"] })]);
  await f.attach(routine.id, v1);
  const old = await f.dispatch(routine.id);
  (await f.h.untilLive(1))[0].finish();
  await old.result;
  const [oldRow] = await f.rows();
  const v2 = await f.h.confirm([autoStageOf("new")], { id: v1.templateId });
  await f.attach(routine.id, v2);
  await (await f.dispatch(routine.id)).result;
  expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "run-unsettled" });
  expect(await f.h.stageRun(oldRow.id, "first")).toMatchObject({ gate: { status: "pending" } });
  expect(f.h.children).toHaveLength(1);
  expect(await f.h.decide(oldRow.id, "first", "approve")).toMatchObject({ ok: true });
  await f.h.until(oldRow.id, row => row.runStatus === "cancelled");
  const next = await f.dispatch(routine.id);
  await f.h.waitForProgress(event => event.stageId === "new" && event.runSessionId !== undefined, "replacement child linked");
  const [child] = await f.h.untilLive(1);
  expect(child.input.unattendedStage).toMatchObject({ stageId: "new" });
  child.finish();
  await next.result;
  expect(await f.rows()).toHaveLength(2);
}));

it.each(["unattended-not-read-only", "tool-effect-unknown"] as const)("Q6 rechecks before the next spawn and cancels with %s", async code => {
  const tool = { stageId: "second", collection: "mcpReadOnlyTools", name: "lookup" } as const;
  let available = true;
  await fixture(async f => {
    const routine = await f.add();
    const version = await f.h.confirm([stageOf("first"), autoStageOf("second", { inputs: ["first"] })]);
    await f.attach(routine.id, version);
    const dispatched = await f.dispatch(routine.id);
    (await f.h.untilLive(1))[0].finish();
    await dispatched.result;
    const [row] = await f.rows();
    available = false;
    expect(await f.h.decide(row.id, "first", "approve")).toMatchObject({ ok: true });
    await f.h.until(row.id, item => item.runStatus === "cancelled");
    const refusal = await f.h.waitForProgress(event => event.itemId === row.id && event.phase === "cancelled", "authority refusal");
    expect(refusal).toMatchObject({ reasonCode: code, ...(code === "tool-effect-unknown" ? { reasonTool: tool } : {}) });
    expect(f.events).toContainEqual({ event: "workflow_authority_refused", itemId: row.id, runId: row.runId, reasonCode: code });
    expect(f.h.children).toHaveLength(1);
    expect(f.h.interrupts).toEqual([]);
  }, { workflow: { unattendedAllowed: () => available ? { ok: true } : code === "tool-effect-unknown" ? { ok: false, code, tool } : { ok: false, code } } });
});

it("a confirmation during the final spawn check refuses the old scope without linking another child", () => fixture(async f => {
  const routine = await f.add();
  const scopeA = project("/project/a");
  const v1 = await f.h.confirm([stageOf("first"), autoStageOf("second", { inputs: ["first"] })], { scope: scopeA });
  await f.attach(routine.id, v1, scopeA);
  const dispatched = await f.dispatch(routine.id);
  (await f.h.untilLive(1))[0].finish();
  await dispatched.result;
  const [row] = await f.rows();
  const read = f.h.templates.get.bind(f.h.templates);
  const confirmDuringCheck = vi.fn(async () => {
    await f.h.confirm([autoStageOf("replacement")], { id: v1.templateId, scope: project("/project/b") });
  });
  const get = vi.spyOn(f.h.templates, "get").mockImplementation(async id => {
    const snapshot = await read(id);
    const stage = await f.h.stageRun(row.id, "second");
    if (stage.workspace && confirmDuringCheck.mock.calls.length === 0) await confirmDuringCheck();
    return snapshot;
  });
  try {
    expect(await f.h.decide(row.id, "first", "approve")).toMatchObject({ ok: true });
    await f.h.waitForProgress(event => event.itemId === row.id &&
      (event.phase === "cancelled" || (event.stageId === "second" && event.runSessionId !== undefined)), "second stage authority");
    expect(confirmDuringCheck).toHaveBeenCalledOnce();
    expect(f.h.children).toHaveLength(1);
    await f.h.until(row.id, item => item.runStatus === "cancelled");
    expect(f.events).toContainEqual({ event: "workflow_authority_refused", itemId: row.id, runId: row.runId, reasonCode: "scope-changed" });
  } finally {
    get.mockRestore();
  }
}));

it.each(["scope-changed", "template-archived"] as const)("a fire refuses %s committed before item creation", code => fixture(async f => {
  const routine = await f.add();
  const scope = project("/project/a");
  const version = await f.h.confirm([autoStageOf("first")], { scope });
  await f.attach(routine.id, version, scope);
  const resolveVersion = f.h.templates.resolveVersion.bind(f.h.templates);
  const interleave = vi.spyOn(f.h.templates, "resolveVersion").mockImplementationOnce(async pin => {
    const resolved = await resolveVersion(pin);
    if (code === "template-archived") await f.h.templates.archive(version.templateId);
    else await f.h.confirm([autoStageOf("replacement")], { id: version.templateId, scope: project("/project/b") });
    return resolved;
  });
  try {
    await (await f.dispatch(routine.id)).result;
    expect(f.store.list()[0].lastFailure).toMatchObject({ reason: code });
    expect(interleave).toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
    expect(await f.h.board.runs.list()).toEqual({ status: "found", runs: [] });
    expect(f.h.workspaceCalls.some(call => call.startsWith("open:"))).toBe(false);
    expect(f.h.children).toEqual([]);
  } finally {
    interleave.mockRestore();
  }
}));

it("rolls back a fire revoked between the board write and beginStart", () => fixture(async f => {
  const routine = await f.add();
  const scope = project("/project/a");
  const version = await f.h.confirm([autoStageOf("first")], { scope });
  await f.attach(routine.id, version, scope);
  const create = f.h.board.create.bind(f.h.board);
  const interleave = vi.spyOn(f.h.board, "create").mockImplementationOnce(async input => {
    const created = await create(input);
    expect(created.status).toBe("created");
    f.h.unauthorised.add("/project/a");
    return created;
  });
  try {
    await (await f.dispatch(routine.id)).result;
    expect(interleave).toHaveBeenCalledOnce();
    expect(f.store.list()[0].lastFailure).toMatchObject({ reason: "scope-not-authorised" });
    expect(await f.rows()).toEqual([]);
    expect(await f.h.board.runs.list()).toEqual({ status: "found", runs: [] });
    expect(f.h.workspaceCalls.some(call => call.startsWith("open:"))).toBe(false);
    expect(f.h.children).toEqual([]);
  } finally {
    interleave.mockRestore();
  }
}));

it.each(["scope-not-authorised", "scope-changed", "attachment-detached"] as const)(
  "rolls back a pre-link %s refusal without a breaker outcome", async code => {
    const tool = { stageId: "first", collection: "mcpReadOnlyTools", name: "lookup" } as const;
    let available = false;
    await fixture(async f => {
      const projectRoot = join(f.h.dir, "project");
      await mkdir(projectRoot);
      const routine = await f.add();
      const scope = project(projectRoot);
      const version = await f.h.confirm([autoStageOf("first")], { scope });
      const attachment = await f.attach(routine.id, version, scope);
      await (await f.dispatch(routine.id)).result;
      expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "tool-effect-unknown", tool });
      available = true;
      let runRoot: string | undefined;
      const updateRun = f.h.board.updateRun.bind(f.h.board);
      const interleave = vi.spyOn(f.h.board, "updateRun").mockImplementation(async (...args) => {
        const result = await updateRun(...args);
        if (runRoot === undefined && result.status === "stored" && result.run.stageRuns.some(stage => stage.workspace)) {
          runRoot = result.run.runWorkspace?.runRoot;
          if (!runRoot) throw new Error("Run workspace was not stored");
          await access(runRoot);
          if (code === "scope-changed") {
            await f.h.confirm([autoStageOf("replacement")], { id: version.templateId, scope: project(join(f.h.dir, "replacement")) });
          } else if (code === "attachment-detached") {
            await f.h.detach(attachment.id);
          } else {
            f.h.unauthorised.add(projectRoot);
          }
        }
        return result;
      });
      try {
        await (await f.dispatch(routine.id)).result;
        expect(f.store.list()[0].lastFailure).toMatchObject({ reason: code });
        expect(await f.rows()).toEqual([]);
        expect(await f.h.board.runs.list()).toEqual({ status: "found", runs: [] });
        expect(f.h.children).toEqual([]);
        expect(f.events).toContainEqual(expect.objectContaining({ event: "workflow_authority_refused", reasonCode: code, runId: expect.any(String) }));
        expect(f.store.list()[0].pausedAt).toBeUndefined();
        if (!runRoot) throw new Error("Expected a prepared workspace");
        await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        interleave.mockRestore();
      }
    }, {
      workflow: { unattendedAllowed: () => available ? { ok: true } : { ok: false, code: "tool-effect-unknown", tool } },
      wiring: store => ({ workspace: createStageWorkspaceProvider({ plainCeiling: tmpdir(), removable: () => store.runsWithoutItem() }) }),
    });
  },
);

it("spawns the pinned child when an unconfirmed draft changes during the final check", () => fixture(async f => {
  const routine = await f.add();
  const scope = project("/project/a");
  const version = await f.h.confirm([autoStageOf("first")], { scope });
  await f.attach(routine.id, version, scope);
  const read = f.h.templates.get.bind(f.h.templates);
  const save = vi.fn(() => f.h.templates.draft(version.templateId, {
    name: "Draft scope", scope: project("/project/b"), stages: [autoStageOf("draft")], edges: [],
  }));
  const get = vi.spyOn(f.h.templates, "get").mockImplementation(async id => {
    const snapshot = await read(id);
    const [row] = await f.rows();
    if (row?.runId && (await f.h.stageRun(row.id, "first")).workspace && save.mock.calls.length === 0) await save();
    return snapshot;
  });
  try {
    const { result } = await f.dispatch(routine.id);
    const [child] = await Promise.race([f.h.untilLive(1), result.then(() => {
      throw new Error(JSON.stringify(f.store.list()[0].lastFailure));
    })]);
    expect(save).toHaveBeenCalledOnce();
    expect(child.input.unattendedStage).toMatchObject({ stageId: "first" });
    child.finish();
    await result;
    expect(f.store.list()[0].lastFailure).toBeUndefined();
  } finally {
    get.mockRestore();
  }
}));

it("a fire stamped before reattach skips the replacement and only a later fire starts it", () => fixture(async f => {
  const routine = await f.add();
  const first = await f.h.confirm([autoStageOf("first")]);
  await f.attach(routine.id, first);
  const replacement = await f.h.confirm([autoStageOf("replacement")], { id: first.templateId });
  const markFired = f.store.markFired.bind(f.store);
  let reattach: ReturnType<typeof f.attach> | undefined;
  const stamp = vi.spyOn(f.store, "markFired").mockImplementationOnce(async (...args) => {
    const stamped = await markFired(...args);
    if (!stamped) throw new Error("Fire was not stamped");
    reattach = f.attach(routine.id, replacement);
    return stamped;
  });
  try {
    const old = await f.dispatch(routine.id);
    await reattach;
    let waitingForOld = true;
    await Promise.race([
      old.result,
      f.h.untilLive(1).then(([child]) => { if (waitingForOld) child.finish(); }),
    ]);
    waitingForOld = false;
    await old.result;
    expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "attachment-replaced" });
    expect(await f.rows()).toEqual([]);
    expect(f.h.children).toEqual([]);
    const next = await f.dispatch(routine.id);
    const [child] = await Promise.race([f.h.untilLive(1), next.result.then(() => {
      throw new Error(JSON.stringify(f.store.list()[0].lastFailure));
    })]);
    expect(child.input.unattendedStage).toMatchObject({ stageId: "replacement" });
    child.finish();
    await next.result;
  } finally {
    stamp.mockRestore();
  }
}));

it("a fire refuses unreadable attachment storage without starting or removing the routine", () => fixture(async f => {
  const routine = await f.add();
  const version = await f.h.confirm([autoStageOf("first")]);
  await f.attach(routine.id, version);
  await writeFile(join(f.h.dir, "templates.json"), "{");
  await (await f.dispatch(routine.id)).result;
  expect(f.store.list()).toMatchObject([{ id: routine.id, lastFailure: { reason: "attachment-unavailable" } }]);
  expect(await f.rows()).toEqual([]);
  expect(await f.h.board.runs.list()).toEqual({ status: "found", runs: [] });
  expect(f.h.children).toEqual([]);
}));

it("preserves the breaker streak across a human gate and clears it on approval and completion", async () => {
  const tool = { stageId: "first", collection: "mcpReadOnlyTools", name: "lookup" } as const;
  let available = false;
  await fixture(async f => {
    const routine = await f.add();
    const version = await f.h.confirm([stageOf("first")]);
    await f.attach(routine.id, version);
    await (await f.dispatch(routine.id)).result;
    available = true;
    const fire = await f.dispatch(routine.id);
    (await f.h.untilLive(1))[0].finish();
    await fire.result;
    const [row] = await f.rows();
    expect((await f.h.stageRun(row.id, "first")).status).toBe("awaiting_gate");
    expect(f.store.list()[0].pausedAt).toBeUndefined();
    await (await f.dispatch(routine.id)).result;
    expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "run-unsettled" });
    await f.h.decide(row.id, "first", "approve");
    await f.h.until(row.id, item => item.runStatus === "completed");

    available = false;
    await (await f.dispatch(routine.id)).result;
    expect(f.store.list()[0].pausedAt).toBeUndefined();
    await (await f.dispatch(routine.id)).result;
    expect(f.store.list()[0].pausedBy).toBe("schedule-breaker");
  }, { workflow: { unattendedAllowed: () => available ? { ok: true } : { ok: false, code: "tool-effect-unknown", tool } } });
});

it("pauses a schedule after registry qualification refuses two fires", async () => {
  const registry = new ToolRegistry();
  const tool = { stageId: "first", collection: "tools", name: "read_file" } as const;
  const effects = createToolEffectResolver(registry);
  await fixture(async f => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const routine = await f.add();
      const version = await f.h.confirm([autoStageOf("first", { envelope: {
        tools: [tool.name], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [],
        mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 2, minutes: 1, costUsd: 0 },
      } })]);
      const attached = await f.attach(routine.id, version);
      await (await f.dispatch(routine.id)).result;
      expect(f.store.list()[0].lastTemplateSkip).toEqual({ code: "tool-effect-unknown", tool });
      expect(f.store.list()[0].pausedAt).toBeUndefined();

      registry.register(createDynamicTool({
        name: tool.name, description: "Read a fixture", source: "builtin", category: "read",
        unattendedEffect: "outward", jsonSchema: { type: "object" },
        execute: async () => ({ output: "", isError: false }),
      }));
      vi.setSystemTime(Date.now() + 1_000);
      await (await f.dispatch(routine.id)).result;
      expect(f.store.list()[0]).toMatchObject({
        lastTemplateSkip: { code: "outward-effect-tool", tool }, pausedBy: "schedule-breaker",
      });
      expect(await f.h.templates.getAttachment(attached.id)).toEqual(attached);
      expect(await f.rows()).toEqual([]);
      expect(f.h.children).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, {
    wiring: (store, { templates, workspace }) => ({
      ...workflowEngineExtensions(store, templates, runScopePermissions(), unavailableOutputAdapter, effects), workspace,
    }),
  });
});

it("counts a stage that fails after a human gate against the same routine", async () => {
  const tool = { stageId: "first", collection: "mcpReadOnlyTools", name: "lookup" } as const;
  let available = false;
  await fixture(async f => {
    const routine = await f.add();
    const version = await f.h.confirm([stageOf("first"), autoStageOf("later", { inputs: ["first"] })]);
    await f.attach(routine.id, version);
    await (await f.dispatch(routine.id)).result;
    available = true;
    const fire = await f.dispatch(routine.id);
    (await f.h.untilLive(1))[0].finish();
    await fire.result;
    const [row] = await f.rows();
    expect(f.store.list()[0].pausedAt).toBeUndefined();
    expect(await f.h.decide(row.id, "first", "approve")).toMatchObject({ ok: true });
    (await f.h.untilLive(1))[0].finish({ ok: false, error: "Stage failed" });
    await untilAsserted(wake => f.store.changed.subscribe(wake), () => {
      expect(f.store.list()[0]).toMatchObject({ pausedBy: "schedule-breaker", lastFailure: { reason: "stage-failed" } });
    }, "the routine to pause after the later stage fails");
  }, { workflow: { unattendedAllowed: () => available ? { ok: true } : { ok: false, code: "tool-effect-unknown", tool } } });
});

it.each(["before classification", "after classification"])("does not count a timed-out failure when Stop settles %s", async settlement => {
  let available = false;
  await fixture(async f => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scanEntered = deferred<void>();
    const scanRelease = deferred<void>();
    try {
      const routine = await f.add();
      const envelope = {
        tools: [], writePaths: [], readRoots: [], network: [], commands: [], mcpReadOnlyTools: [],
        mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 2, minutes: 1, costUsd: 0 },
      };
      await f.attach(routine.id, await f.h.confirm([stageOf("first"), autoStageOf("later", { inputs: ["first"], envelope })]));
      await (await f.dispatch(routine.id)).result;
      expect(f.store.list()[0].pausedAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      available = true;
      const fire = await f.dispatch(routine.id);
      (await f.h.untilLive(1))[0].finish();
      await fire.result;
      const [row] = await f.rows();
      expect(await f.h.decide(row.id, "first", "approve")).toMatchObject({ ok: true });
      const [later] = await f.h.untilLive(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await f.h.untilStage(row.id, "later", "failed");
      expect(f.h.engine.cancelRun(row.id)).toEqual({ ok: true });
      await f.h.drainRunWork();
      expect(later.ended).toBe(false);
      if (settlement === "before classification") {
        const readOutcome = f.h.engine.readScheduledOutcome;
        vi.spyOn(f.h.engine, "readScheduledOutcome").mockImplementationOnce(async snapshot => {
          expect(snapshot.settled).toBeUndefined();
          scanEntered.resolve();
          await scanRelease.promise;
          return readOutcome(snapshot);
        });
      }
      const scan = await f.dispatch(routine.id);
      if (settlement === "before classification") {
        await scanEntered.promise;
        later.finish({ ok: false, stopReason: "interrupted" });
        await f.h.drainRunWork();
        expect((await f.h.item(row.id)).record?.settled?.status).toBe("cancelled");
        scanRelease.resolve();
      }
      await scan.result;
      expect(f.store.list()[0]).toMatchObject({ lastTemplateSkip: { code: "run-unsettled" } });
      expect(f.store.list()[0].pausedBy).toBeUndefined();
      if (!later.ended) later.finish({ ok: false, stopReason: "interrupted" });
      await f.h.drainRunWork();
      expect((await f.h.item(row.id)).record?.settled?.status).toBe("cancelled");
    } finally {
      scanRelease.resolve();
      vi.useRealTimers();
    }
  }, {
    interruptChild: vi.fn(),
    workflow: { unattendedAllowed: () => available ? { ok: true } : {
      ok: false, code: "tool-effect-unknown", tool: { stageId: "first", collection: "mcpReadOnlyTools", name: "lookup" },
    } },
  });
});
