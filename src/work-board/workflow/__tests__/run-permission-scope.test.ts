/** A template run's permission scope: the engine links each stage child with its stage and the run's lane, tells its end, and ends the
 * scope once, when the run is over. */
import { afterEach, expect, it, vi } from "vitest";
import { registerRunSession, runGrantKeyOfSession, runSessionOf, __resetRunGrantsForTest } from "../../../permissions/run-grants.js";
import { createRunScopeHooks } from "../../../permissions/run-scope.js";
import { listSessionApprovals, lookupUserDecision, recordApproval, __resetSessionStoreForTest } from "../../../permissions/user-approval-store.js";
import { autoStageOf, runScopePermissions, stageOf } from "./stage-fixtures.js";
import { stageRunHarness } from "./stage-run-harness.js";
import type { StageRunEngineDeps } from "../stage-run-engine.js";

afterEach(() => {
  __resetRunGrantsForTest();
  __resetSessionStoreForTest();
  vi.restoreAllMocks();
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

it("links opted-in grandchildren with the stage's own workspace and run scope", async () => {
  const manager = runScopePermissions();
  const bound = new Map<string, string>();
  const h = await stageRunHarness({ workflow: {
    runScope: createRunScopeHooks(manager),
    workspaceBinding: { bind: (id, root) => { bound.set(id, root); }, unbind: id => { bound.delete(id); } },
  } });
  try {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: true })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [stage] = await h.untilLive(1);
    const bind = stage.callbacks?.onStageSubAgentLinked;
    if (!bind) throw new Error("No sub-agent link for the opted-in stage");
    const release = bind("grandchild", "Extract");
    expect(h.events).toContainEqual(expect.objectContaining({ stageId: "a", runSessionId: stage.sessionId, subAgentSessionId: "grandchild" }));
    expect(stage.input.stageSubAgents).toMatchObject({ stageName: "Stage a", runKey: runGrantKeyOfSession(stage.sessionId), max: 3 });
    expect(bound.get("grandchild")).toBe(bound.get(stage.sessionId));
    expect(runSessionOf("grandchild")).toMatchObject({ stageId: "a", stageName: "Stage a", agentTitle: "Extract", lane: "attended" });
    expect(runGrantKeyOfSession("grandchild")).toBe(runGrantKeyOfSession(stage.sessionId));
    release();
    expect(bound.has("grandchild")).toBe(false);
    expect(runSessionOf("grandchild")).toBeUndefined();
    stage.finish();
    await run;
    expect(() => bind("too-late", "Extract")).toThrow();
  } finally {
    await h.cleanup();
  }
});

it("rolls back a partially initialized run scope and preserves another run's session", async () => {
  const manager = runScopePermissions();
  const runScope = createRunScopeHooks(manager);
  runScope.sessionLinked("another-run", "existing", { stageId: "b", stageName: "Stage b", lane: "attended" });
  for (const invocation of ["one", "two", "three"]) manager.resolveReviewerChoice("existing", invocation, "deny");
  const beginReview = manager.beginRunSessionReview.bind(manager);
  const bound = new Set<string>();
  const h = await stageRunHarness({ workflow: {
    runScope,
    workspaceBinding: {
      bind: sessionId => { bound.add(sessionId); },
      unbind: sessionId => { bound.delete(sessionId); },
    },
  } });
  try {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: true })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [stage] = await h.untilLive(1);
    const bind = stage.callbacks?.onStageSubAgentLinked;
    if (!bind) throw new Error("No sub-agent link for the opted-in stage");
    vi.spyOn(manager, "beginRunSessionReview").mockImplementationOnce(sessionId => {
      beginReview(sessionId);
      for (const invocation of ["one", "two", "three"]) manager.resolveReviewerChoice(sessionId, invocation, "deny");
      throw new Error("Reviewer initialization failed");
    });

    expect(() => bind("partial", "Extract")).toThrow("Reviewer initialization failed");
    expect(bound.has("partial")).toBe(false);
    expect(runSessionOf("partial")).toBeUndefined();
    expect(manager.getAutomatedApprovalPauseReason("partial")).toBeUndefined();

    expect(() => bind("existing", "Extract")).toThrow(expect.objectContaining({ code: "session-in-another-run" }));
    expect(runSessionOf("existing")).toMatchObject({ runKey: "another-run", stageId: "b" });
    expect(manager.getAutomatedApprovalPauseReason("existing")).toBe("consecutive");
    stage.finish();
    expect(await run).toMatchObject({ status: "completed" });
  } finally {
    runScope.sessionEnded("existing");
    await h.cleanup();
  }
});

it("records an interrupted stage when the workspace bind fails with sub-agents disabled", async () => {
  const unbind = vi.fn();
  const h = await stageRunHarness({ workflow: {
    workspaceBinding: {
      bind: () => { throw new Error("Stage workspace disappeared"); },
      unbind,
    },
  } });
  try {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: false })]);
    const id = await h.addItem(version);
    await h.start(id, h.local(version));
    const [stage] = h.children;
    expect(await h.stageRun(id, "a")).toMatchObject({ failure: "interrupted" });
    expect(h.interrupts).toEqual([stage.sessionId]);
    expect(unbind).toHaveBeenCalledExactlyOnceWith(stage.sessionId);
  } finally {
    await h.cleanup();
  }
});

it("links only the scheduled stage and tears down its workspace and lane", async () => {
  const manager = runScopePermissions();
  const budget = { rounds: 2, minutes: 1, costUsd: 0 };
  const envelope = {
    budget, tools: ["read_file"], commands: [], readRoots: [], writePaths: [],
    network: [], outputs: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
  };
  const sessionLinked = vi.fn<NonNullable<StageRunEngineDeps["lane"]>["sessionLinked"]>();
  const tornDown: string[] = [];
  const h = await stageRunHarness({ workflow: {
    unattendedAllowed: () => ({ ok: true }),
    runScope: createRunScopeHooks(manager),
    workspaceBinding: { bind: () => undefined, unbind: sessionId => { tornDown.push(`workspace:${sessionId}`); } },
    lane: {
      admit: async () => ({ ok: true }),
      sessionLinked,
      sessionEnded: sessionId => { tornDown.push(`lane:${sessionId}`); },
      onDenied: () => () => undefined,
    },
  } });
  await h.runThenEnd(async () => {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: true, envelope })]);
    const id = await h.addItem(version);
    const { source } = await h.attach(version);
    const run = h.start(id, source);
    const [stage] = await h.untilLive(1);
    expect(stage.input.maxRounds).toBe(budget.rounds);
    expect(stage.input.stageSubAgents).toBeUndefined();
    expect(stage.callbacks?.onStageSubAgentLinked).toBeUndefined();
    expect(sessionLinked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: stage.sessionId, stageId: "a", workspaceRoot: stage.input.projectRoot, envelope,
    }));
    expect(runSessionOf(stage.sessionId)?.lane).toBe("unattended");
    expect(runGrantKeyOfSession(stage.sessionId)).toBeUndefined();
    stage.finish();
    expect(await run).toMatchObject({ status: "completed" });
    expect(runSessionOf(stage.sessionId)).toBeUndefined();
    expect(tornDown).toEqual([`workspace:${stage.sessionId}`, `lane:${stage.sessionId}`]);
  });
});

it("an attended stage keeps its existing round ceiling with an envelope", async () => {
  const h = await stageRunHarness();
  try {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: true, envelope: {
      budget: { rounds: 2, minutes: 1, costUsd: 0 }, tools: ["read_file"], commands: [], readRoots: [], writePaths: [],
      network: [], outputs: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
    } })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [stage] = await h.untilLive(1);
    expect(stage.input.maxRounds).toBe(20);
    stage.finish();
    expect(await run).toMatchObject({ status: "completed" });
  } finally {
    await h.cleanup();
  }
});

it("tears down both sessions in the same workspace and run-scope order", async () => {
  const order: string[] = [];
  const h = await stageRunHarness({ workflow: {
    workspaceBinding: {
      bind: (sessionId) => { order.push(`bind:${sessionId}`); },
      unbind: sessionId => { order.push(`unbind:${sessionId}`); },
    },
    runScope: {
      sessionLinked: (_runKey, sessionId) => { order.push(`link:${sessionId}`); },
      sessionEnded: sessionId => { order.push(`end:${sessionId}`); },
      runEnded: () => undefined,
    },
  } });
  try {
    const version = await h.confirm([autoStageOf("a", { allowSubAgents: true })]);
    const id = await h.addItem(version);
    const run = h.start(id, h.local(version));
    const [stage] = await h.untilLive(1);
    const bind = stage.callbacks?.onStageSubAgentLinked;
    if (!bind) throw new Error("No sub-agent link for the opted-in stage");
    const release = bind("grandchild", "Extract");
    release();
    stage.finish();
    await run;
    expect(order).toEqual([
      `bind:${stage.sessionId}`, `link:${stage.sessionId}`, "bind:grandchild", "link:grandchild",
      "unbind:grandchild", "end:grandchild", `unbind:${stage.sessionId}`, `end:${stage.sessionId}`,
    ]);
  } finally {
    await h.cleanup();
  }
});
