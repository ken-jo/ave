import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import type { TailnetRequestedOutputDecision, TailnetWorkDecisionRequest } from "../../shared/tailnet-work-decisions.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { RoutinesStore } from "../routines-store.js";
import { createTailnetWorkDecisions } from "../tailnet-work-decisions.js";
import { itemDigestOf, planHashOf } from "../work-board-store.js";

const base = { id: "0f3b6ea5-4de9-444e-9aee-8a1691e2e005", scope: "7e63f524-3125-445f-a4c0-726cf9341848" };
const login = "owner@example.com";
const existingOutput = "a".repeat(64);
const staleHash = "b".repeat(64);
const privateNote = "Do not put this note in the audit";
const evidence = { login, conversationId: "active-conversation", authority: { refreshCurrent: async () => true, isCurrent: () => true } };

async function fixture(options: Parameters<typeof stageRunHarness>[0] = {}) {
  const h = await stageRunHarness({ observeRunWork: true, ...options });
  const routines = new RoutinesStore(join(h.dir, "routines.json"));
  routines.bindTemplateAttachments(h.templates);
  const log = vi.fn();
  const settings = DEFAULT_SETTINGS;
  const runtime = createTailnetWorkDecisions({
    workBoardStore: h.board, workBoardEngine: h.engine, workflowTemplateStore: h.templates, routinesStore: routines,
    auditLogger: { log }, settingsService: { get: key => settings[key] },
  });
  if (!runtime) throw new Error("Work decision runtime unavailable");
  return { h, routines, log, runtime, decide: (request: TailnetWorkDecisionRequest) => runtime.decide(request, evidence) };
}

it("decides the current stored plan and audits the verified login without the note", async () => {
  const { h, decide, log } = await fixture();
  await h.runThenEnd(async () => {
    const created = await h.board.create({ title: "Review work" });
    if (created.status !== "created") throw new Error("Work item not created");
    const runId = "plan-run";
    const plan = "Plan contents stay on the work item";
    await h.board.beginRun(created.itemId, runId, "2026-01-01T00:00:00Z");
    await h.board.setPlanAwaitingApproval(created.itemId, { runId, plan, runSessionId: "plan-session", revision: 1, itemDigest: itemDigestOf(created.item) });
    const request = { ...base, kind: "plan", itemId: created.itemId, input: { runId, planHash: staleHash, decision: "reject", note: privateNote } } as const;
    await expect(decide(request)).resolves.toEqual({ ok: false, error: "plan_mismatch" });
    expect(log).not.toHaveBeenCalled();
    await expect(decide({ ...request, input: { ...request.input, planHash: planHashOf(plan) } })).resolves.toEqual({ ok: true, kind: "plan", status: "rejected" });
    expect(log).toHaveBeenCalledOnce();
    const data = log.mock.calls[0][0].output;
    expect(data).not.toContain(privateNote);
    expect(data).not.toContain(plan);
    expect(JSON.parse(data)).toMatchObject({ origin: "tailnet-surface", login, runId });
    expect(h.children).toHaveLength(0);
  });
});

it.each(["stage", "join"] as const)("binds a remote %s decision to the current work identity and hash", async kind => {
  const { h, decide, log } = await fixture({
    integrate: () => ({ ok: false, conflict: { conflictHash: existingOutput, reason: "merge-conflict", files: [] } }),
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm(kind === "stage" ? [stageOf("a")] : [autoStageOf("a")]);
    const itemId = await h.addItem(version);
    const start = h.start(itemId, h.local(version));
    (await h.untilLive(1, itemId))[0].finish();
    await start;
    const item = await h.item(itemId);
    const runId = item.runId ?? "";
    const decision = (hash: string): TailnetWorkDecisionRequest => kind === "stage"
      ? { ...base, kind, itemId, input: { runId, stageId: "a", attempt: 1, resultHash: hash, decision: "reject", note: privateNote } }
      : { ...base, kind, itemId, input: { runId, joinId: item.stageJoins[0].joinId, generation: item.stageJoins[0].conflictGeneration ?? 0, conflictHash: hash, decision: "reject" } };
    const hash = kind === "stage" ? item.stageRuns[0].resultHash : item.stageJoins[0].conflict?.conflictHash;
    if (!hash) throw new Error("No pending work decision");
    await expect(decide(decision(staleHash))).resolves.toEqual({ ok: false, error: kind === "stage" ? "result_mismatch" : "conflict_mismatch" });
    await expect(decide(decision(hash))).resolves.toMatchObject({ ok: true, kind });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateNote);
    expect(JSON.parse(log.mock.calls[0][0].output)).toMatchObject({ origin: "tailnet-surface", login, runId, decision: kind === "join" ? "reject" : "rejected" });
  });
});

it("rejects a stale template revision and starts only the exact confirmed remote version", async () => {
  const { h, decide, log } = await fixture();
  await h.runThenEnd(async () => {
    const record = await h.templates.draft(null, { name: "Work", scope: { kind: "all" }, stages: [stageOf("a")], edges: [] });
    const draft = record.draft;
    if (!draft) throw new Error("No draft");
    const request = { ...base, kind: "template-confirmation", templateId: record.template.id, input: { expectedGraphHash: draft.graphHash, expectedDraftRevision: draft.revision } } as const;
    await expect(decide({ ...request, input: { ...request.input, expectedDraftRevision: "prior-draft" } })).resolves.toEqual({ ok: false, error: "stale-draft" });
    const confirmed = await decide(request);
    if (!confirmed.ok || confirmed.kind !== "template-confirmation") throw new Error("Template not confirmed");
    const start = { ...base, kind: "create-and-run", input: { title: "Remote work", ...confirmed.pin } } as const;
    await expect(decide({ ...start, input: { ...start.input, graphHash: staleHash } })).resolves.toEqual({ ok: false, error: "graph-hash-mismatch" });
    expect(h.children).toHaveLength(0);
    const result = await decide(start);
    if (!result.ok || result.kind !== "create-and-run") throw new Error("Template not started");
    expect(await h.runOf(result.runId)).toMatchObject({ pin: confirmed.pin, runStartedBy: { kind: "tailnet-create-and-run", pin: confirmed.pin } });
    const [child] = await h.untilLive(1, result.itemId);
    expect(child.input).not.toHaveProperty("remoteControllerAuthority");
    expect(log).toHaveBeenCalledTimes(2);
    const { confirmation } = await h.templates.resolveVersion(confirmed.pin);
    expect(JSON.parse(log.mock.calls[0][0].output)).toMatchObject({ kind: "template-confirmation", auditId: confirmation.auditId });
  });
});

it("attaches a schedule with the exact pin and removes a routine created for a refused attachment", async () => {
  const { h, decide, routines, log } = await fixture();
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    const pin = h.pinOf(version);
    const request = { ...base, kind: "schedule-attachment", input: { ...pin, expectedScope: { kind: "all" }, schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } } } } as const;
    await expect(decide({ ...request, input: { ...request.input, graphHash: staleHash } })).resolves.toEqual({ ok: false, error: "graph-hash-mismatch" });
    expect(routines.list()).toEqual([]);
    const result = await decide(request);
    if (!result.ok || result.kind !== "schedule-attachment") throw new Error("Schedule not attached");
    const attachment = await h.templates.getAttachment(result.attachmentId);
    expect(attachment).toMatchObject({ ...pin, who: login, origin: "tailnet-surface", scheduleId: result.scheduleId, auditId: expect.any(String) });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0].output)).toMatchObject({ kind: "schedule-attachment", auditId: attachment?.auditId });
  });
});

it("dispatches requested outputs only while their owner is registered", async () => {
  const { h, decide, runtime, log } = await fixture();
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("a")]);
    const itemId = await h.addItem(version);
    const start = h.start(itemId, h.local(version));
    (await h.untilLive(1, itemId))[0].finish();
    await start;
    const { runId } = await h.item(itemId);
    if (!runId) throw new Error("No pending run");
    const input = { itemId, runId, stageId: "a", attempt: 1, outputId: "output", outputHash: existingOutput, decision: "approve" } as const;
    const request = { ...base, kind: "requested-output", input } as const;
    await expect(decide(request)).resolves.toEqual({ ok: false, error: "requested-output-unavailable" });
    const handler = vi.fn(async (decision: TailnetRequestedOutputDecision) => decision.outputHash === existingOutput
      ? { ok: true as const } : { ok: false as const, error: "output_mismatch" });
    const remove = runtime.registerRequestedOutputDecision(handler);
    await expect(decide({ ...request, input: { ...input, runId: "stale-run" } })).resolves.toEqual({ ok: false, error: "run_mismatch" });
    await expect(decide({ ...request, input: { ...input, outputHash: staleHash } })).resolves.toEqual({ ok: false, error: "output_mismatch" });
    await expect(decide(request)).resolves.toEqual({ ok: true, kind: "requested-output" });
    expect(handler).toHaveBeenLastCalledWith(input, expect.objectContaining({ login, conversationId: evidence.conversationId }));
    remove();
    await expect(decide(request)).resolves.toEqual({ ok: false, error: "requested-output-unavailable" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  });
});

it("leaves a plan pending when authority is lost in its board transaction", async () => {
  const { h, runtime, log } = await fixture();
  await h.runThenEnd(async () => {
    const created = await h.board.create({ title: "Review work" });
    if (created.status !== "created") throw new Error("Work item not created");
    const runId = "queued-plan";
    const plan = "A pending plan";
    await h.board.beginRun(created.itemId, runId, "2026-01-01T00:00:00Z");
    await h.board.setPlanAwaitingApproval(created.itemId, { runId, plan, runSessionId: "plan-session", revision: 1, itemDigest: itemDigestOf(created.item) });
    const queued = deferred<void>();
    const release = deferred<void>();
    const authority = { refreshCurrent: async () => { queued.resolve(); await release.promise; return true; }, isCurrent: () => false };
    const result = runtime.decide({ ...base, kind: "plan", itemId: created.itemId, input: { runId, planHash: planHashOf(plan), decision: "approve" } }, { ...evidence, authority });
    await queued.promise;
    release.resolve();
    await expect(result).resolves.toEqual({ ok: false, error: "remote-controller-authority-revoked" });
    expect((await h.item(created.itemId)).planApproval).toMatchObject({ status: "pending" });
    expect(h.children).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });
});
