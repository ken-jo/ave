import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withholdSessionAuthorityFor } from "../../shared/turn-extension-policy.js";

const { PermissionManager } = await import("../permission-manager.js");
const { createRunScopeHooks } = await import("../run-scope.js");
const { RunGrantError, isRunStageSession, registerRunSession, runGrantKeyOfSession, runSessionOf, setRunSessionParentResolver, __resetRunGrantsForTest } = await import("../run-grants.js");
const { lookupUserDecision, listApprovals, recordApproval, userApprovalFilePath, __resetSessionStoreForTest } = await import("../user-approval-store.js");

const RUN = "work-board:7#run-a";
const OTHER_RUN = "work-board:7#run-b";
const ARGS = '{"query":"status"}';

let dir: string;
let manager: InstanceType<typeof PermissionManager>;
let hooks: ReturnType<typeof createRunScopeHooks>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "run-grants-")));
  vi.stubEnv("AVE_HOME", join(dir, "state"));
  for (const stage of ["plan", "build", "other"]) mkdirSync(join(dir, stage));
  __resetSessionStoreForTest();
  __resetRunGrantsForTest();
  manager = new PermissionManager(join(dir, "permissions.json"));
  hooks = createRunScopeHooks(manager);
});
afterEach(() => {
  __resetSessionStoreForTest();
  __resetRunGrantsForTest();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const link = (runKey: string, sessionId: string, stageId: string, lane: "attended" | "unattended" = "attended") =>
  hooks.sessionLinked(runKey, sessionId, { stageId, stageName: stageId, lane });
/** Each stage session works in its own folder, as a stage workspace does. */
const lookup = (sessionId: string, stage = "plan") => lookupUserDecision("status_probe", ARGS, "mcp", "llm-tool-arg", undefined, join(dir, stage), sessionId);
const allowForRun = (sessionId: string) => recordApproval("status_probe", ARGS, "mcp", {
  scope: "run", sessionId, verdictAtApproval: "medium", nlJustification: null, trustOrigin: "llm-tool-arg",
});
const shell = (command: string, sessionId: string, stage = "plan") => manager.checkDetailed("bash", "builtin", "shell", null, {
  ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command, cwd: join(dir, stage) },
  shellExecution: { runsSandboxed: false },
  sessionId,
});

describe("run membership", () => {
  it("links a stage session to one run and refuses a second run for it", () => {
    link(RUN, "plan-session", "plan");
    expect(runSessionOf("plan-session")).toEqual({ runKey: RUN, stageId: "plan", stageName: "plan", lane: "attended" });
    expect(runGrantKeyOfSession("plan-session")).toBe(RUN);
    // The same link again changes nothing.
    expect(registerRunSession(RUN, "plan-session", { stageId: "plan", stageName: "plan", lane: "attended" })).toBe(false);
    expect(() => registerRunSession(OTHER_RUN, "plan-session", { stageId: "plan", stageName: "plan", lane: "attended" }))
      .toThrow(expect.objectContaining({ name: "RunGrantError", code: "session-in-another-run" }));
    expect(() => registerRunSession(RUN, "", { stageId: "plan", stageName: "plan", lane: "attended" })).toThrow(RunGrantError);
  });

  it("a run that ended takes no session again", () => {
    link(RUN, "plan-session", "plan");
    hooks.runEnded(RUN);
    expect(runSessionOf("plan-session")).toBeUndefined();
    expect(() => link(RUN, "late-session", "build")).toThrow(expect.objectContaining({ code: "run-ended" }));
    expect(runSessionOf("late-session")).toBeUndefined();
  });
});

// Permission tree, template runs: a stage session's sub-agent shares the run grant and shows its stage.
describe("a stage session's sub-agent", () => {
  const parents: Record<string, string> = { "plan-helper": "plan-session", "plan-helper-2": "plan-helper", "plan-session": "work-board:7", "chat-helper": "chat-session" };
  beforeEach(() => setRunSessionParentResolver(sessionId => parents[sessionId]));

  it("works under its nearest linked ancestor's membership, not the item's", async () => {
    link(RUN, "plan-session", "plan");
    expect(runSessionOf("plan-helper")).toEqual({ runKey: RUN, stageId: "plan", stageName: "plan", lane: "attended" });
    expect(runSessionOf("plan-helper-2")).toMatchObject({ stageId: "plan" });
    expect(isRunStageSession("plan-helper")).toBe(false);
    expect(runSessionOf("chat-helper")).toBeUndefined();
    expect(runSessionOf("work-board:7")).toBeUndefined();

    // The sub-agent reads the grant its stage's card made, and makes one its stage's siblings read.
    link(RUN, "build-session", "build");
    await allowForRun("plan-session");
    expect(await lookup("plan-helper", "plan")).toMatchObject({ scope: "run", decision: "allow" });
    manager.addRunRule("plan-helper", "Bash(printf ready)");
    expect(shell("printf ready", "build-session", "build")).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(await lookup("chat-helper", "plan")).toBeNull();
  });

  it("has no membership once its stage ended, under a schedule-started stage makes no grant, and a cyclic record fails clearly", async () => {
    link(RUN, "plan-session", "plan");
    hooks.sessionEnded("plan-session");
    expect(runSessionOf("plan-helper")).toBeUndefined();
    await expect(allowForRun("plan-helper")).rejects.toMatchObject({ code: "not-a-run-member" });

    link(OTHER_RUN, "scheduled-session", "plan", "unattended");
    parents["scheduled-helper"] = "scheduled-session";
    expect(runSessionOf("scheduled-helper")).toMatchObject({ lane: "unattended" });
    expect(runGrantKeyOfSession("scheduled-helper")).toBeUndefined();

    parents["loop-a"] = "loop-b";
    parents["loop-b"] = "loop-a";
    expect(() => runSessionOf("loop-a")).toThrow(expect.objectContaining({ name: "RunGrantError", code: "invalid-ancestry" }));
  });
});

describe("Allow for this run: exact approvals (permission tree, node R)", () => {
  it("a sibling stage session reuses an allow-run grant", async () => {
    link(RUN, "plan-session", "plan");
    link(RUN, "build-session", "build");
    expect(await lookup("build-session", "build")).toBeNull();
    await allowForRun("plan-session");
    expect(await lookup("plan-session", "plan")).toMatchObject({ scope: "run", decision: "allow" });
    // The sibling works in another folder; the grant is keyed by the run, not by the folder.
    expect(await lookup("build-session", "build")).toMatchObject({ scope: "run", decision: "allow" });
  });

  it("a session of another run of the same item does not, nor does a session outside any run", async () => {
    link(RUN, "plan-session", "plan");
    link(OTHER_RUN, "other-run-session", "plan");
    await allowForRun("plan-session");
    expect(await lookup("other-run-session", "plan")).toBeNull();
    expect(await lookup("chat-session", "plan")).toBeNull();
    expect(await lookup("work-board:7", "plan")).toBeNull();
  });

  it("the grant is gone after the run ends, and a stage that ended alone leaves it for its siblings", async () => {
    link(RUN, "plan-session", "plan");
    link(RUN, "build-session", "build");
    await allowForRun("plan-session");
    hooks.sessionEnded("plan-session");
    expect(await lookup("plan-session", "plan")).toBeNull();
    expect(await lookup("build-session", "build")).toMatchObject({ scope: "run" });
    hooks.runEnded(RUN);
    expect(await lookup("build-session", "build")).toBeNull();
    expect((await listApprovals()).filter(entry => entry.scope === "run")).toEqual([]);
  });

  it("a record after the run ended is refused", async () => {
    link(RUN, "plan-session", "plan");
    hooks.runEnded(RUN);
    await expect(allowForRun("plan-session")).rejects.toMatchObject({ name: "RunGrantError", code: "not-a-run-member" });
    await expect(allowForRun("chat-session")).rejects.toMatchObject({ code: "not-a-run-member" });
    expect((await listApprovals()).filter(entry => entry.scope === "run")).toEqual([]);
  });

  it("a record whose run ends while its authority is checked stores nothing", async () => {
    link(RUN, "plan-session", "plan");
    const authority = { refresh: async () => { hooks.runEnded(RUN); return true; }, isCurrent: () => true };
    await expect(recordApproval("status_probe", ARGS, "mcp", {
      scope: "run", sessionId: "plan-session", verdictAtApproval: "medium", nlJustification: null, trustOrigin: "llm-tool-arg",
    }, authority)).rejects.toMatchObject({ code: "not-a-run-member" });
    expect((await listApprovals()).filter(entry => entry.scope === "run")).toEqual([]);
  });

  it("scope run is never written to disk", async () => {
    link(RUN, "plan-session", "plan");
    await allowForRun("plan-session");
    expect(existsSync(userApprovalFilePath())).toBe(false);
    // A later persistent write keeps the run row out of the file.
    await recordApproval("other_probe", "{}", "mcp", { scope: "global", verdictAtApproval: "low", nlJustification: null });
    const file = JSON.parse(await (await import("node:fs/promises")).readFile(userApprovalFilePath(), "utf8")) as { approvals: Record<string, { scope: string }> };
    expect(Object.values(file.approvals).map(entry => entry.scope)).toEqual(["global"]);
    expect(await lookup("plan-session", "plan")).toMatchObject({ scope: "run" });
  });

  it("a persistent deny beats a run allow, and a deny at run scope is refused", async () => {
    link(RUN, "plan-session", "plan");
    await allowForRun("plan-session");
    await recordApproval("status_probe", ARGS, "mcp", { decision: "deny", scope: "global", verdictAtApproval: "medium", nlJustification: null, trustOrigin: "llm-tool-arg" });
    expect(await lookup("plan-session", "plan")).toMatchObject({ scope: "global", decision: "deny" });
    await expect(recordApproval("status_probe", ARGS, "mcp", {
      decision: "deny", scope: "run", sessionId: "plan-session", verdictAtApproval: "medium", nlJustification: null,
    })).rejects.toThrow("A run approval is an allow");
  });

  it("a schedule-started stage session makes and reads no run grant", async () => {
    link(RUN, "plan-session", "plan");
    link(OTHER_RUN, "scheduled-session", "plan", "unattended");
    expect(runGrantKeyOfSession("scheduled-session")).toBeUndefined();
    await expect(allowForRun("scheduled-session")).rejects.toMatchObject({ code: "not-a-run-member" });
    // Nor does a wake turn that inherits no session allows read the run's.
    await allowForRun("plan-session");
    const release = withholdSessionAuthorityFor("plan-session");
    try { expect(await lookup("plan-session", "plan")).toBeNull(); } finally { release(); }
    expect(await lookup("plan-session", "plan")).toMatchObject({ scope: "run" });
  });
});

describe("Allow for this run: shell rules", () => {
  it("a run rule allows a sibling's same command, not another run's, and ends with the run", () => {
    link(RUN, "plan-session", "plan");
    link(RUN, "build-session", "build");
    link(OTHER_RUN, "other-run-session", "other");
    const epoch = manager.getPolicyEpoch();
    manager.addRunRule("plan-session", "Bash(printf ready)");
    expect(manager.getPolicyEpoch()).not.toBe(epoch);
    expect(shell("printf ready", "plan-session", "plan")).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(shell("printf ready", "build-session", "build")).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    expect(shell("printf ready", "other-run-session", "other")).toMatchObject({ decision: "ask" });
    expect(shell("printf ready", "chat-session")).toMatchObject({ decision: "ask" });
    const beforeEnd = manager.getPolicyEpoch();
    hooks.runEnded(RUN);
    expect(manager.getPolicyEpoch()).not.toBe(beforeEnd);
    expect(shell("printf ready", "build-session", "build")).toMatchObject({ decision: "ask" });
  });

  it("only a session of a live attended run adds a run rule", () => {
    link(RUN, "scheduled-session", "plan", "unattended");
    expect(() => manager.addRunRule("scheduled-session", "Bash(printf ready)")).toThrow(expect.objectContaining({ code: "not-a-run-member" }));
    expect(() => manager.addRunRule("chat-session", "Bash(printf ready)")).toThrow(expect.objectContaining({ code: "not-a-run-member" }));
    link(OTHER_RUN, "plan-session", "plan");
    expect(() => manager.addRunRule("plan-session", "write_file")).toThrow("A run rule must be a Bash(...), PowerShell(...) or Network(...) rule");
    expect(shell("printf ready", "scheduled-session")).toMatchObject({ decision: "ask" });
  });

  it("a deny rule still wins over a run rule", () => {
    link(RUN, "plan-session", "plan");
    manager.addRunRule("plan-session", "Bash(printf ready)");
    manager.setRules([{ pattern: "Bash(printf ready)", action: "deny" }]);
    expect(shell("printf ready", "plan-session", "plan")).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
  });
});
