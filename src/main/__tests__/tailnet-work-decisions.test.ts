import { join, win32 } from "node:path";
import { expect, it, vi } from "vitest";
import { setupCommittedAveHome } from "../../__tests__/support/committed-ave-home.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { parseTailnetWorkDecision } from "../../api/tailnet-work-decision-input.js";
import { outputHashOf } from "../../shared/workflow-template-output.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import * as allowedDirectories from "../../permissions/allowed-directories.js";
import { foldCanonicalPathSeparators } from "../../permissions/sensitive-paths.js";
import type { TailnetRequestedOutputDecision, TailnetWorkDecisionRequest } from "../../shared/tailnet-work-decisions.js";
import { ToolRegistry } from "../../tools/registry.js";
import { autoStageOf, stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { RoutinesStore } from "../routines-store.js";
import { createTailnetWorkDecisions } from "../tailnet-work-decisions.js";
import { itemDigestOf, planHashOf } from "../work-board-store.js";

setupCommittedAveHome("tailnet-work-decisions-");

const base = { id: "0f3b6ea5-4de9-444e-9aee-8a1691e2e005", scope: "7e63f524-3125-445f-a4c0-726cf9341848" };
const login = "owner@example.com";
const existingOutput = "a".repeat(64);
const staleHash = "b".repeat(64);
const privateNote = "Do not put this note in the audit";
const evidence = { login, conversationId: "active-conversation", authority: { refreshCurrent: async () => true, isCurrent: () => true } };

function fromWire(request: TailnetWorkDecisionRequest): TailnetWorkDecisionRequest {
  const parsed = parseTailnetWorkDecision(JSON.parse(JSON.stringify(request)));
  if (!parsed) throw new Error(`Invalid listed binding for ${request.kind}`);
  return parsed;
}

async function fixture(options: Parameters<typeof stageRunHarness>[0] = {}) {
  const h = await stageRunHarness({ observeRunWork: true, ...options });
  const routines = new RoutinesStore(join(h.dir, "routines.json"));
  routines.bindTemplateAttachments(h.templates);
  const log = vi.fn();
  const settings = DEFAULT_SETTINGS;
  const runtime = createTailnetWorkDecisions({
    workBoardStore: h.board, workBoardEngine: h.engine, workflowTemplateStore: h.templates, routinesStore: routines,
    auditLogger: { log }, settingsService: { get: key => settings[key] }, toolRegistry: new ToolRegistry(),
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
  const { h, decide, log, runtime } = await fixture({
    integrate: () => ({ ok: false, conflict: { conflictHash: existingOutput, reason: "merge-conflict", files: [] } }),
  });
  await h.runThenEnd(async () => {
    const version = await h.confirm(kind === "stage" ? [stageOf("a")] : [autoStageOf("a")]);
    const itemId = await h.addItem(version);
    const start = h.start(itemId, h.local(version));
    (await h.untilLive(1, itemId))[0].finish();
    await start;
    const offered = (await runtime.list(evidence)).find(review => review.kind === kind);
    if (!offered || (offered.kind !== "stage" && offered.kind !== "join")) throw new Error("Missing gate review");
    const { binding } = offered;
    if (offered.kind === "stage") {
      const request = { ...base, kind: offered.kind, ...offered.binding, input: { ...offered.binding.input, decision: "reject", note: privateNote } } as const;
      await expect(decide(fromWire({ ...request, input: { ...request.input, resultHash: staleHash } }))).resolves.toEqual({ ok: false, error: "result_mismatch" });
      await expect(decide(fromWire(request))).resolves.toEqual({ ok: true, kind, status: "rejected" });
    } else {
      const request = { ...base, kind: offered.kind, ...offered.binding, input: { ...offered.binding.input, decision: "reject" } } as const;
      await expect(decide(fromWire({ ...request, input: { ...request.input, conflictHash: staleHash } }))).resolves.toEqual({ ok: false, error: "conflict_mismatch" });
      await expect(decide(fromWire(request))).resolves.toEqual({ ok: true, kind });
    }
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateNote);
    expect(JSON.parse(log.mock.calls[0][0].output)).toMatchObject({ origin: "tailnet-surface", login, runId: binding.input.runId, decision: kind === "join" ? "reject" : "rejected" });
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
    const run = await h.runOf(result.runId);
    expect(run).toMatchObject({ pin: confirmed.pin, runStartedBy: { kind: "tailnet-create-and-run", pin: confirmed.pin } });
    expect(await h.item(result.itemId)).not.toHaveProperty("remoteProvisional");
    expect(await h.board.list()).toMatchObject({ items: [expect.objectContaining({ id: result.itemId })] });
    const [child] = await h.untilLive(1, result.itemId);
    expect(child.input).not.toHaveProperty("remoteControllerAuthority");
    expect(log).toHaveBeenCalledTimes(2);
    const { confirmation } = await h.templates.resolveVersion(confirmed.pin);
    expect(JSON.parse(log.mock.calls[0][0].output)).toMatchObject({ kind: "template-confirmation", auditId: confirmation.auditId });
  });
});

it("lists and binds the registered Windows project when a template uses native separators", async () => {
  const nativeRoot = win32.join("C:\\", "Projects", "Selected");
  const otherNativeRoot = win32.join("C:\\", "Projects", "Selected-neighbor");
  const host = process.platform;
  const [root, otherRoot] = (() => {
    setProcessPlatform("win32");
    try { return [foldCanonicalPathSeparators(nativeRoot), foldCanonicalPathSeparators(otherNativeRoot)]; }
    finally { setProcessPlatform(host); }
  })();
  expect(root).toBe("c:/Projects/Selected");

  const { h, runtime, decide } = await fixture();
  await h.runThenEnd(async () => {
    const allowed = vi.spyOn(allowedDirectories, "sanitizeRuntimeAllowedDirectories").mockReturnValue([root, otherRoot]);
    const create = vi.spyOn(h.board, "create").mockResolvedValue({ status: "invalid", reason: "board-unavailable" });
    try {
      const version = await h.confirm([stageOf("a")], { scope: { kind: "project", projectRoot: nativeRoot } });
      const review = (await runtime.list(evidence)).find(entry => entry.kind === "create-and-run");
      expect(review).toMatchObject({ binding: { input: { projectRoot: root } }, review: { projects: [{ projectRoot: root }] } });

      const start = { ...base, kind: "create-and-run", input: { ...h.pinOf(version), title: "Scoped work" } } as const;
      await expect(decide(start)).resolves.toEqual({ ok: false, error: "project-mismatch" });
      await expect(decide({ ...start, input: { ...start.input, projectRoot: otherNativeRoot } })).resolves.toEqual({ ok: false, error: "project-mismatch" });
      expect(create).not.toHaveBeenCalled();
      await expect(decide({ ...start, input: { ...start.input, projectRoot: nativeRoot } })).resolves.toEqual({ ok: false, error: "work-item-create-refused" });
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectRoot: root }), expect.anything());
    } finally {
      create.mockRestore();
      allowed.mockRestore();
    }
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

it.each(["archived pin", "last failure"] as const)("includes the desktop schedule's %s when reviewing reattachment", async detail => {
  const { h, decide, routines, runtime } = await fixture();
  await h.runThenEnd(async () => {
    const prior = h.pinOf(await h.confirm([stageOf("prior")]));
    const next = h.pinOf(await h.confirm([stageOf("next")]));
    const attached = await decide({ ...base, kind: "schedule-attachment", input: {
      ...prior, expectedScope: { kind: "all" }, schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } },
    } });
    if (!attached.ok || attached.kind !== "schedule-attachment") throw new Error("Schedule not attached");
    if (detail === "archived pin") {
      await h.templates.archive(prior.templateId);
    } else {
      const fired = await routines.markFired(attached.scheduleId);
      if (!fired?.lastFiredAt) throw new Error("Schedule not fired");
      await routines.recordRunOutcome(attached.scheduleId, fired.lastFiredAt, { ok: false, kind: "error", reason: "Stage failed" });
    }
    const offered = (await runtime.list(evidence)).find(review =>
      review.kind === "schedule-attachment" && review.binding.input.templateId === next.templateId);
    if (offered?.kind !== "schedule-attachment") throw new Error("Missing reattachment review");
    if (detail === "archived pin") {
      expect(offered.review.existingPin).toEqual(prior);
    } else {
      const [desktop] = (await routines.listScheduleDisplay()).routines;
      expect(desktop.lastFailure).toMatchObject({ kind: "error", reason: "Stage failed" });
      expect(offered.review.routine?.lastFailure).toEqual(desktop.lastFailure);
    }
  });
});

it("withholds the prior schedule pin after its current template scope leaves the authorized projects", async () => {
  const { h, decide, routines, runtime } = await fixture();
  await h.runThenEnd(async () => {
    const prior = h.pinOf(await h.confirm([stageOf("prior")]));
    const next = h.pinOf(await h.confirm([stageOf("next")]));
    const attached = await decide({ ...base, kind: "schedule-attachment", input: {
      ...prior, expectedScope: { kind: "all" }, schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } },
    } });
    if (!attached.ok || attached.kind !== "schedule-attachment") throw new Error("Schedule not attached");
    await h.confirm([stageOf("prior")], {
      id: prior.templateId, scope: { kind: "project", projectRoot: h.dir },
    });
    const [desktop] = (await routines.listScheduleDisplay()).routines;
    expect(desktop.templateAttention).toBe("scope-changed");
    const reviews = await runtime.list(evidence);
    expect(reviews.some(review => review.kind === "create-and-run" && review.binding.input.templateId === prior.templateId)).toBe(false);
    const offered = reviews.find(review =>
      review.kind === "schedule-attachment" && review.binding.input.templateId === next.templateId);
    if (offered?.kind !== "schedule-attachment") throw new Error("Missing reattachment review");
    expect(offered.review).not.toHaveProperty("existingPin");
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
    const decl = { kind: "external-write", toolName: "publish_note", owner: "plugin", ownerId: "notes" } as const;
    const outputs = [
      { id: "first", decl, args: "{}", summary: "First output" },
      { id: "second", decl, args: "{}", summary: "Second output" },
    ];
    const stored = await h.board.updateRun(itemId, runId, run => ({
      ...run, stageRuns: run.stageRuns.map(stage => ({
        ...stage, requestedOutputs: outputs, outputHash: outputHashOf(stage.output ?? "", outputs),
      })),
    }));
    if (stored.status !== "stored") throw new Error("Could not store pending outputs");
    const stage = stored.run.stageRuns[0];
    const input = { itemId, runId, stageId: "a", attempt: 1, outputHash: stage.outputHash ?? "", decision: "approve" } as const;
    const request = { ...base, kind: "requested-output", input } as const;
    expect(parseTailnetWorkDecision(request)).toEqual(request);
    expect(parseTailnetWorkDecision({ ...request, input: { ...input, outputId: "first" } })).toBeNull();
    await expect(decide(request)).resolves.toEqual({ ok: false, error: "requested-output-unavailable" });
    const handler = vi.fn(async (_decision: TailnetRequestedOutputDecision) => ({ ok: true as const }));
    const list = vi.fn(async () => ({ outputs }));
    const remove = runtime.registerRequestedOutputDecision({ decide: handler, list });
    const { decision: _decision, ...binding } = input;
    const reviews = await runtime.list(evidence);
    expect(reviews).toContainEqual({ kind: "requested-output", deny: "reject", binding: { input: binding }, review: { outputs } });
    const offered = reviews.find(review => review.kind === "requested-output");
    if (!offered) throw new Error("Missing requested-output review");
    expect(list).toHaveBeenCalledWith(binding, expect.objectContaining({ login, conversationId: evidence.conversationId }));
    await expect(decide({ ...request, input: { ...input, runId: "stale-run" } })).resolves.toEqual({ ok: false, error: "run_mismatch" });
    await expect(decide({ ...request, input: { ...input, outputHash: staleHash } })).resolves.toEqual({ ok: false, error: "output_mismatch" });
    await expect(decide(fromWire({ ...base, kind: offered.kind, input: { ...offered.binding.input, decision: "approve" } })))
      .resolves.toEqual({ ok: true, kind: "requested-output" });
    const { itemId: _itemId, ...stageBinding } = input;
    await expect(decide({ ...base, kind: "stage", itemId, input: { ...stageBinding, resultHash: stage.resultHash ?? "" } }))
      .resolves.toEqual({ ok: true, kind: "stage", status: "approved" });
    expect(handler).toHaveBeenLastCalledWith(input, expect.objectContaining({ login, conversationId: evidence.conversationId }), undefined);
    expect((await h.item(itemId)).stageRuns[0].gate).toMatchObject({ status: "pending" });
    expect(h.children).toHaveLength(1);
    remove();
    expect(await runtime.list(evidence)).not.toContainEqual(expect.objectContaining({ kind: "requested-output" }));
    await expect(decide(request)).resolves.toEqual({ ok: false, error: "requested-output-unavailable" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
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

it("shares the desktop review binding for a conversation proposal and makes owner-initiated denial local", async () => {
  const { h, runtime, decide } = await fixture();
  await h.runThenEnd(async () => {
    const draft = { name: "Review this graph", scope: { kind: "all" as const }, stages: [stageOf("a")], edges: [] };
    const proposal = h.templates.propose(evidence.conversationId, draft);
    const hidden = h.templates.propose("other-conversation", { ...draft, name: "Other conversation" });
    const reviews = await runtime.list(evidence);
    expect(reviews).not.toContainEqual(expect.objectContaining({ binding: expect.objectContaining({ templateId: hidden.id }) }));
    const confirmation = reviews.find(review => review.kind === "template-confirmation");
    if (!confirmation) throw new Error("Missing confirmation review");
    expect(confirmation).toMatchObject({ deny: "dismiss", review: proposal.draft });
    const confirmationRequest = { ...base, kind: confirmation.kind, ...confirmation.binding };
    expect(parseTailnetWorkDecision(confirmationRequest)).toEqual(confirmationRequest);
    expect(parseTailnetWorkDecision({ ...confirmationRequest, input: { ...confirmation.binding.input, decision: "reject" } })).toBeNull();
    expect(parseTailnetWorkDecision({ ...confirmationRequest, input: { ...confirmation.binding.input, expectedDraftRevision: "bad revision" } })).toBeNull();
    await expect(decide(fromWire(confirmationRequest))).resolves.toMatchObject({ ok: true, kind: "template-confirmation" });

    const run = (await runtime.list(evidence)).find(review => review.kind === "create-and-run");
    if (!run) throw new Error("Missing run review");
    expect(run).toMatchObject({ deny: "dismiss", review: { name: draft.name, graph: { stages: draft.stages, edges: [] } } });
    const runRequest = { ...base, kind: run.kind, ...run.binding };
    expect(parseTailnetWorkDecision(runRequest)).toMatchObject(runRequest);
    expect(parseTailnetWorkDecision({ ...runRequest, input: { ...runRequest.input, decision: "reject" } })).toBeNull();
    const started = await decide(fromWire(runRequest));
    if (!started.ok || started.kind !== "create-and-run") throw new Error("Template not started");
    expect(h.children).toHaveLength(1);
    (await h.untilLive(1, started.itemId))[0].finish();

    const scheduleRequest = { ...base, kind: "schedule-attachment", input: {
      templateId: run.binding.input.templateId, version: run.binding.input.version, graphHash: run.binding.input.graphHash,
      expectedScope: run.review.scope, schedule: { at: "2026-12-01T00:00:00.000Z" },
    } } as const;
    const attachment = await decide(scheduleRequest);
    if (!attachment.ok || attachment.kind !== "schedule-attachment") throw new Error("Missing schedule attachment");
    const schedule = (await runtime.list(evidence)).find(review => review.kind === "schedule-attachment");
    if (!schedule) throw new Error("Missing attachment review");
    expect(schedule).toMatchObject({ deny: "dismiss", binding: { input: { scheduleId: attachment.scheduleId } }, review: { existingPin: {
      templateId: run.binding.input.templateId, version: run.binding.input.version, graphHash: run.binding.input.graphHash,
    } } });
    const reattach = { ...base, kind: schedule.kind, ...schedule.binding };
    expect(parseTailnetWorkDecision(reattach)).toEqual(reattach);
    expect(parseTailnetWorkDecision({ ...reattach, input: { ...reattach.input, decision: "reject" } })).toBeNull();
    await expect(decide(fromWire(reattach))).resolves.toMatchObject({ ok: true, kind: "schedule-attachment", scheduleId: attachment.scheduleId });
  });
});
