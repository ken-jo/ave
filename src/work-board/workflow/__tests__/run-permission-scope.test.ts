/** A template run's permission scope: the engine links each stage child with its stage and the run's lane, tells its end, and ends the
 * scope once, when the run is over. */
import { afterEach, expect, it } from "vitest";
import { registerRunSession, runGrantKeyOfSession, runSessionOf, __resetRunGrantsForTest } from "../../../permissions/run-grants.js";
import { createRunScopeHooks } from "../../../permissions/run-scope.js";
import { listSessionApprovals, lookupUserDecision, recordApproval, __resetSessionStoreForTest } from "../../../permissions/user-approval-store.js";
import { autoStageOf, runScopePermissions, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";

afterEach(() => {
  __resetRunGrantsForTest();
  __resetSessionStoreForTest();
});

type Told = ["linked", string, string, { stageId: string; stageName: string; lane: string }] | ["ended", string] | ["run-ended", string];
function recording() {
  const told: Told[] = [];
  return {
    told,
    runScope: {
      sessionLinked: (runKey: string, sessionId: string, member: { stageId: string; stageName: string; lane: "attended" | "unattended" }) => { told.push(["linked", runKey, sessionId, member]); },
      sessionEnded: (sessionId: string) => { told.push(["ended", sessionId]); },
      runEnded: (runKey: string) => { told.push(["run-ended", runKey]); },
    },
  };
}

it("links each stage child with its stage and the attended lane, tells each child's end, and ends the scope once when the run is over", async () => {
  const { told, runScope } = recording();
  const h = await stageRunHarness({ workflow: { runScope } });
  try {
    const version = await h.confirm([autoStageOf("a"), autoStageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [first] = await h.untilLive(1);
    const runKey = `work-board:${id}#${(await h.item(id)).runId}`;
    expect(told).toEqual([["linked", runKey, first.sessionId, { stageId: "a", stageName: "Stage a", lane: "attended" }]]);
    first.finish({ summary: "first" });
    const [, second] = await h.untilSpawned(2);
    second.finish({ summary: "second" });
    expect(await run).toMatchObject({ status: "completed" });
    expect(told).toEqual([
      ["linked", runKey, first.sessionId, { stageId: "a", stageName: "Stage a", lane: "attended" }],
      ["ended", first.sessionId],
      ["linked", runKey, second.sessionId, { stageId: "b", stageName: "Stage b", lane: "attended" }],
      ["ended", second.sessionId],
      ["run-ended", runKey],
    ]);
  } finally {
    await h.cleanup();
  }
});

it("links the stage children of a schedule-started run as unattended", async () => {
  const { told, runScope } = recording();
  const h = await stageRunHarness({ workflow: { runScope } });
  try {
    const version = await h.confirm([autoStageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, (await h.attach(version)).source);
    const [child] = await h.untilLive(1);
    expect(told).toEqual([["linked", expect.stringContaining(`work-board:${id}#`), child.sessionId, { stageId: "a", stageName: "Stage a", lane: "unattended" }]]);
    child.finish({ summary: "done" });
    expect(await run).toMatchObject({ status: "completed" });
    expect(told.at(-1)?.[0]).toBe("run-ended");
  } finally {
    await h.cleanup();
  }
});

it("a gate that waits keeps the run's scope open, and a stopped run ends it", async () => {
  const { told, runScope } = recording();
  const h = await stageRunHarness({ workflow: { runScope } });
  try {
    const version = await h.confirm([stageOf("a")]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [child] = await h.untilLive(1);
    child.finish({ summary: "for review" });
    await h.untilStage(id, "a", "awaiting_gate");
    expect(told.map(([kind]) => kind)).toEqual(["linked", "ended"]);
    expect(h.engine.cancelRun(id)).toEqual({ ok: true });
    expect((await run).status).toBe("cancelled");
    expect(told.map(([kind]) => kind)).toEqual(["linked", "ended", "run-ended"]);
  } finally {
    await h.cleanup();
  }
});

it("on the production scope a stage session is a run member while it lives, and the run's grant is revoked when the run ends", async () => {
  const manager = runScopePermissions();
  const h = await stageRunHarness({ workflow: { runScope: createRunScopeHooks(manager) } });
  try {
    const version = await h.confirm([autoStageOf("a"), autoStageOf("b", { inputs: ["a"] })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [first] = await h.untilLive(1);
    const runKey = `work-board:${id}#${(await h.item(id)).runId}`;
    expect(runSessionOf(first.sessionId)).toEqual({ runKey, stageId: "a", stageName: "Stage a", lane: "attended" });
    await recordApproval("status_probe", "{}", "mcp", { scope: "run", sessionId: first.sessionId, verdictAtApproval: "medium", nlJustification: null });
    manager.addRunRule(first.sessionId, "Bash(printf ready)");
    first.finish({ summary: "first" });

    // The next stage of the same run reads the grant the first stage's card made.
    const [, second] = await h.untilSpawned(2);
    expect(runSessionOf(first.sessionId)).toBeUndefined();
    expect(runGrantKeyOfSession(second.sessionId)).toBe(runKey);
    expect(await lookupUserDecision("status_probe", "{}", "mcp", undefined, undefined, undefined, second.sessionId)).toMatchObject({ scope: "run" });
    const shell = () => manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command: "printf ready", cwd: h.dir }, shellExecution: { runsSandboxed: false }, sessionId: second.sessionId,
    });
    expect(shell()).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    second.finish({ summary: "second" });
    expect(await run).toMatchObject({ status: "completed" });

    // Over: no member, no row, no rule, and the run takes no session again.
    expect(runSessionOf(second.sessionId)).toBeUndefined();
    expect(listSessionApprovals()).toEqual([]);
    expect(shell()).toMatchObject({ decision: "ask" });
    expect(() => registerRunSession(runKey, "late-session", { stageId: "b", stageName: "Stage b", lane: "attended" })).toThrow(expect.objectContaining({ code: "run-ended" }));
  } finally {
    await h.cleanup();
  }
});
