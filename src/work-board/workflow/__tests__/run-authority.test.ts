import { describe, expect, it } from "vitest";
import { en } from "../../../i18n/messages/en.js";
import { ko } from "../../../i18n/messages/ko.js";
import type {
  EnvelopeToolRef, RunAuthoritySource, ScheduleAttachment, UnattendedQualification, WorkflowTemplate,
} from "../../../shared/workflow-template-types.js";
import { authoriseRunSource, type AuthoriseRunSourceArgs } from "../run-authority.js";
import { graphOf, stageOf, versionOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

const A = "/projects/a";
const B = "/projects/b";
const stored = versionOf(graphOf([stageOf("a")]));
const pin = { templateId: stored.templateId, version: stored.version, graphHash: stored.graphHash };
const template: WorkflowTemplate = { id: stored.templateId, name: "Template", scope: { kind: "all" }, currentVersion: 1, createdAt: stored.confirmedAt, updatedAt: stored.confirmedAt };
const attachment: ScheduleAttachment = { ...pin, id: "att-1", scheduleId: "daily", approvedScope: { kind: "all" }, who: "alice", at: stored.confirmedAt, origin: "local-desktop" };
const local: RunAuthoritySource = { kind: "local-create-and-run", pin };
const schedule: RunAuthoritySource = { kind: "schedule-attachment", attachmentId: attachment.id, pin, firedAt: stored.confirmedAt };
const tool: EnvelopeToolRef = { stageId: "a", collection: "tools", name: "send_mail" };

function args(over: Partial<AuthoriseRunSourceArgs>): AuthoriseRunSourceArgs {
  return {
    phase: "start", source: local, runPin: pin, template, stored, storedHashMatches: true, attachment: null, runProjectRoot: undefined,
    scopeAuthorised: () => true, unattendedAllowed: () => ({ ok: true }), ...over,
  };
}
const scheduled = (over: Partial<AuthoriseRunSourceArgs> = {}): AuthoriseRunSourceArgs => args({ source: schedule, attachment, ...over });
const projectScope = { kind: "project", projectRoot: A } as const;

describe("authoriseRunSource", () => {
  it.each<[string, AuthoriseRunSourceArgs, ReturnType<typeof authoriseRunSource>]>([
    ["Create and run of the current version", args({}), { ok: true, source: "local-create-and-run", lane: "attended" }],
    ["Create and run on the card's project", args({ source: { ...local, projectRoot: A }, runProjectRoot: A }), { ok: true, source: "local-create-and-run", lane: "attended" }],
    ["a tuple that is not the run's", args({ source: { ...local, pin: { ...pin, version: 2 } } }), { ok: false, code: "pin-mismatch" }],
    ["stored content that no longer hashes to the pin", args({ storedHashMatches: false, stored: null }), { ok: false, code: "graph-mismatch" }],
    ["a stored version with another hash", args({ stored: { ...stored, graphHash: "b".repeat(64) } }), { ok: false, code: "graph-mismatch" }],
    ["a version that does not exist", args({ stored: null }), { ok: false, code: "version-missing" }],
    ["a template that is gone", args({ template: null }), { ok: false, code: "version-missing" }],
    ["an archived template", args({ template: { ...template, archivedAt: stored.confirmedAt } }), { ok: false, code: "template-archived" }],
    ["a version that is not current", args({ template: { ...template, currentVersion: 2 } }), { ok: false, code: "not-current-version" }],
    ["a pinned run after a newer version was confirmed", args({ phase: "spawn", template: { ...template, currentVersion: 2 } }), { ok: true, source: "local-create-and-run", lane: "attended" }],
    ["a project other than the card's", args({ source: { ...local, projectRoot: A }, runProjectRoot: B }), { ok: false, code: "project-mismatch" }],
    ["a card with no project on an item with one", args({ runProjectRoot: A }), { ok: false, code: "project-mismatch" }],
    ["a project that is no longer authorised", args({ source: { ...local, projectRoot: A }, runProjectRoot: A, scopeAuthorised: () => false }), { ok: false, code: "scope-not-authorised" }],

    ["a schedule on its attachment pin", scheduled(), { ok: true, source: "schedule-attachment", lane: "unattended" }],
    ["a schedule while a newer version is current", scheduled({ template: { ...template, currentVersion: 2 } }), { ok: true, source: "schedule-attachment", lane: "unattended" }],
    ["a schedule on the snapshot's project", scheduled({ template: { ...template, scope: projectScope }, attachment: { ...attachment, approvedScope: projectScope }, runProjectRoot: A }), { ok: true, source: "schedule-attachment", lane: "unattended" }],
    ["a schedule with no attachment", scheduled({ attachment: null }), { ok: false, code: "attachment-missing" }],
    ["a schedule naming another attachment", scheduled({ attachment: { ...attachment, id: "att-2" } }), { ok: false, code: "attachment-missing" }],
    ["a detached attachment", scheduled({ attachment: { ...attachment, detachedAt: stored.confirmedAt } }), { ok: false, code: "attachment-detached" }],
    ["an attachment of another version", scheduled({ attachment: { ...attachment, version: 2 } }), { ok: false, code: "pin-mismatch" }],
    ["a template that gained a project scope", scheduled({ template: { ...template, scope: projectScope } }), { ok: false, code: "scope-changed" }],
    ["a template that moved to another project", scheduled({ template: { ...template, scope: { kind: "project", projectRoot: B } }, attachment: { ...attachment, approvedScope: projectScope }, runProjectRoot: A }), { ok: false, code: "scope-changed" }],
    ["a template that lost its project scope", scheduled({ attachment: { ...attachment, approvedScope: projectScope }, runProjectRoot: A }), { ok: false, code: "scope-changed" }],
    ["a run on a project other than the snapshot's", scheduled({ template: { ...template, scope: projectScope }, attachment: { ...attachment, approvedScope: projectScope }, runProjectRoot: B }), { ok: false, code: "project-mismatch" }],
    ["a snapshot that is no longer authorised", scheduled({ scopeAuthorised: () => false }), { ok: false, code: "scope-not-authorised" }],
    ["a version that may not run unattended", scheduled({ unattendedAllowed: () => ({ ok: false, code: "unattended-not-read-only" }) }), { ok: false, code: "unattended-not-read-only" }],
    ["an envelope tool with an outward effect", scheduled({ unattendedAllowed: () => ({ ok: false, code: "outward-effect-tool", tool }) }), { ok: false, code: "outward-effect-tool", tool }],
    ["an envelope tool with no effect evidence", scheduled({ unattendedAllowed: () => ({ ok: false, code: "tool-effect-unknown", tool }) }), { ok: false, code: "tool-effect-unknown", tool }],
  ])("%s", (_label, input, verdict) => {
    expect(authoriseRunSource(input)).toEqual(verdict);
  });

  it("an unknown source kind is refused", () => {
    for (const source of [{ kind: "agent-tool", pin }, { pin }, null]) {
      expect(authoriseRunSource(args({ source: source as unknown as RunAuthoritySource }))).toEqual({ ok: false, code: "source-not-authorised" });
    }
  });

  it("asks the unattended qualification only for a schedule, with the stored version", () => {
    const asked: unknown[] = [];
    const unattendedAllowed = (version: unknown): UnattendedQualification => { asked.push(version); return { ok: true }; };
    authoriseRunSource(args({ unattendedAllowed }));
    expect(asked).toEqual([]);
    authoriseRunSource(scheduled({ unattendedAllowed }));
    expect(asked).toEqual([stored]);
  });
});

it.each<UnattendedQualification & { ok: false }>([
  { ok: false, code: "unattended-not-read-only" },
  { ok: false, code: "outward-effect-tool", tool },
  { ok: false, code: "tool-effect-unknown", tool },
])("a refusal of unattendedAllowed reaches the verdict, the refused start and the settle event with its code unchanged, and with its tool for outward-effect-tool and tool-effect-unknown ($code)", async (refusal) => {
  const reason = { reasonCode: refusal.code, ...("tool" in refusal ? { reasonTool: refusal.tool } : {}) };
  expect(authoriseRunSource(scheduled({ unattendedAllowed: () => refusal }))).toEqual(refusal);

  let qualifies = false;
  const h = await stageRunHarness({ workflow: { unattendedAllowed: () => qualifies ? { ok: true } : refusal } });
  try {
    const auto = { gate: { type: "auto", pass: { kind: "stage_ok" } } } as const;
    const version = await h.confirm([stageOf("a", auto), stageOf("b", { ...auto, inputs: ["a"] })]);
    const source = (await h.attach(version)).source;
    const refused = await h.addItem(version);
    const start = await h.start(refused, source);
    expect(start).toMatchObject({ status: "error", ...reason });
    if (!("tool" in refusal)) expect(start.reasonTool).toBeUndefined();
    expect((await h.item(refused)).runId).toBeUndefined();
    expect(h.children).toHaveLength(0);

    qualifies = true;
    const id = await h.addItem(version);
    const run = h.start(id, source);
    const [a] = await h.untilLive(1);
    qualifies = false;
    a.finish();
    expect(await run).toMatchObject({ status: "cancelled", ...reason });
    const settled = await h.settleEvent();
    expect(settled).toMatchObject({ phase: "cancelled", ...reason });
    if (!("tool" in refusal)) expect(settled.reasonTool).toBeUndefined();
    expect(h.audits).toEqual([{ itemId: id, runId: (await h.item(id)).runId, event: "work-run:authority-refused", code: refusal.code, ...("tool" in refusal ? { tool: refusal.tool } : {}) }]);
    expect(h.children).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

it("a start refused project-mismatch or scope-not-authorised returns that reasonCode, and each has an en and a ko message", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version, A);
    expect(await h.start(id, h.local(version, B))).toMatchObject({ status: "error", reasonCode: "project-mismatch" });
    h.unauthorised.add(A);
    expect(await h.start(id, h.local(version, A))).toMatchObject({ status: "error", reasonCode: "scope-not-authorised" });
    expect(h.children).toHaveLength(0);
  } finally {
    await h.cleanup();
  }
  const codes = [
    "project-mismatch", "scope-not-authorised", "scope-changed", "source-not-authorised", "pin-mismatch", "not-current-version", "template-archived",
    "version-missing", "graph-mismatch", "attachment-missing", "attachment-detached", "unattended-not-read-only",
  ];
  for (const code of codes) for (const catalog of [en, ko]) expect(Reflect.get(catalog, `reasonCodes.${code}`)).toEqual(expect.stringMatching(/\S/));
});

it("accepts a gate decision while a sibling stage is running", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const [a, b] = await h.untilLive(2);
    a.finish();
    await h.untilStage(id, "a", "awaiting_gate");
    expect(b.ended).toBe(false);
    expect(await h.decide(id, "a", "approve")).toEqual({ ok: true, status: "approved" });
    const item = await h.untilStage(id, "a", "passed");
    expect(h.statusOf(item, "b")).toBe("running");
    expect(b.ended).toBe(false);
    expect(h.interrupts).toEqual([]);
    h.engine.cancelRun(id);
    await h.until(id, current => current.runStatus === "cancelled");
  } finally {
    await h.cleanup();
  }
});

it("refuses a gate decision with another attempt or result hash", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    (await h.untilLive(1))[0].finish();
    await run;
    const before = await h.item(id);
    const gate = await h.stageRun(id, "a");
    const good = { runId: before.runId ?? "", stageId: "a", attempt: 1, resultHash: gate.resultHash ?? "", decision: "approve" } as const;
    expect(await h.engine.decideStageGate(id, { ...good, attempt: 2 })).toEqual({ ok: false, reason: "attempt_mismatch" });
    expect(await h.engine.decideStageGate(id, { ...good, resultHash: "c".repeat(64) })).toEqual({ ok: false, reason: "result_mismatch" });
    expect(await h.engine.decideStageGate(id, { ...good, runId: "00000000-0000-4000-8000-000000000000" })).toEqual({ ok: false, reason: "run_mismatch" });
    expect(await h.engine.decideStageGate(id, { ...good, stageId: "zz" })).toEqual({ ok: false, reason: "not_found" });
    expect(await h.engine.decideStageGate(id, { ...good, decision: "request_changes" })).toEqual({ ok: false, reason: "note_required" });
    expect(await h.item(id)).toEqual(before);
    expect(await h.engine.decideStageGate(id, good)).toEqual({ ok: true, status: "approved" });
    expect((await h.until(id, item => item.runStatus !== "executing")).runStatus).toBe("completed");
    expect(await h.engine.decideStageGate(id, good)).toMatchObject({ ok: false });
  } finally {
    await h.cleanup();
  }
});

it("steer reaches the named stage's child only", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([stageOf("a"), stageOf("b")]);
    const id = await h.addItem(version);
    void h.start(id, h.local(version));
    const [a, b] = await h.untilLive(2);
    expect(h.engine.steerRun(id, "cover the edge cases", "b")).toMatchObject({ ok: true });
    expect(b.steers).toEqual(["cover the edge cases"]);
    expect(a.steers).toEqual([]);
    expect(h.engine.steerRun(id, "go", "zz")).toEqual({ ok: false, reason: "not-executing" });
    // Without a stage a template run has no single child to steer.
    expect(h.engine.steerRun(id, "go")).toMatchObject({ ok: false });
    expect(a.steers).toEqual([]);
    h.engine.cancelRun(id);
    await h.until(id, current => current.runStatus === "cancelled");
  } finally {
    await h.cleanup();
  }
});
