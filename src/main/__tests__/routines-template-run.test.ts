import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RoutineRecord } from "../../shared/routines-types.js";
import type { TemplateScope, TemplateVersion } from "../../shared/workflow-template-types.js";
import { createRoutineScheduleTool } from "../../tools/routine-schedule.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { RoutinesScheduler } from "../routines-scheduler.js";
import { RoutinesStore, removeRoutineWithRuns } from "../routines-store.js";
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
  const path = join(h.dir, "routines.json");
  const store = new RoutinesStore(path);
  store.bindTemplateAttachments(h.templates);
  const scheduler = new RoutinesScheduler(store, async () => []);
  const dispatches: Promise<void>[] = [];
  const { fireScheduledTemplate } = await import("../routines-template-run.js");
  const fire = (routine: RoutineRecord) => fireScheduledTemplate({
    routinesStore: store, workflowTemplateStore: h.templates, workBoardStore: h.board, workBoardEngine: h.engine,
  }, routine);
  scheduler.onTemplateRun(({ routine }) => { dispatches.push(fire(routine)); });
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
  return { h, path, store, add, attach, dispatch, poll, rows };
}

it("the store refuses the kind without the attach proof", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    const store = new RoutinesStore(join(h.dir, "routines.json"));
    store.bindTemplateAttachments(h.templates);
    await expect(store.add(input())).rejects.toMatchObject({ code: "invalid-input" });
    await expect(store.add(input(), { origin: "local-desktop" } as never)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(store.add(input(), mintHostDecisionProof("tailnet-surface"))).rejects.toMatchObject({ code: "invalid-input" });
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
  const child = await vi.waitFor(() => {
    const active = f.h.live().find(candidate => candidate.input.unattendedStage?.stageId === "new");
    if (!active) throw new Error("New scheduled child has not linked");
    return active;
  });
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
    await f.h.waitForProgress(event => event.itemId === row.id && event.phase === "cancelled", "authority refusal");
    expect(f.h.audits.at(-1)).toMatchObject({ code, ...(code === "tool-effect-unknown" ? { tool } : {}) });
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
    expect(f.h.audits.at(-1)).toMatchObject({ code: "scope-changed" });
  } finally {
    get.mockRestore();
  }
}));
