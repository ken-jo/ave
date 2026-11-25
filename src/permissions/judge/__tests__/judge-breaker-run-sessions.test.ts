import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionTestResources } from "../../__tests__/test-resources.js";
import { NO_APPROVER_MESSAGE } from "../../decision-pipeline.js";
import { PermissionManager } from "../../permission-manager.js";
import { __resetRunGrantsForTest } from "../../run-grants.js";
import { createRunScopeHooks } from "../../run-scope.js";
import { DEFAULT_JUDGE_SETTINGS } from "../judge-settings.js";

const resources = new PermissionTestResources();
const ITEM = "work-board:7";
const RUN = `${ITEM}#run-a`;

let root: string;
let manager: PermissionManager;
let hooks: ReturnType<typeof createRunScopeHooks>;
/** What the reviewer says of the next call. */
let level: "high" | "low";

beforeEach(() => {
  __resetRunGrantsForTest();
  level = "high";
  root = resources.makeTmpDir("ave-run-breaker-");
  manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("auto");
  manager.setReviewer({ classifier: { classify: () => ({ level, reason: level === "high" ? "blocked" : "fine" }) }, cache: resources.makeVerdictCache(join(root, "verdicts.jsonl")) });
  // Every child of the board row resolves to the row, as the host's spawn record says; `chat-child-*` to one conversation.
  manager.setJudge({
    settings: { ...DEFAULT_JUDGE_SETTINGS, chain: [], categories: { ...DEFAULT_JUDGE_SETTINGS.categories }, breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker } },
    chain: [], breaker: manager.getJudgeBreaker(),
    audit: { logShadow() {}, async appendPermissionAuditEntry(entry) { return { ...entry, prevHash: "test" }; } },
  }, sessionId => sessionId.startsWith("chat-child-") ? "chat-root" : sessionId.endsWith("-session") ? ITEM : sessionId);
  hooks = createRunScopeHooks(manager);
});
afterEach(async () => {
  __resetRunGrantsForTest();
  await resources.cleanup();
});

const link = (sessionId: string, stageId: string, lane: "attended" | "unattended" = "attended") =>
  hooks.sessionLinked(RUN, sessionId, { stageId, stageName: stageId, lane });
const review = (sessionId: string, lane: "foreground-auto" | "headless" = "foreground-auto") => manager.dispatchReviewer("write_probe", {
  invocationId: randomUUID(), sessionId, source: "builtin", category: "write", pathFields: ["path"],
  finalInput: { path: join(root, `${randomUUID()}.txt`) }, executionCwd: root, allowedDirectories: [root],
  sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
}, undefined, { lane });
const block = async (sessionId: string, times: number) => { for (let index = 0; index < times; index += 1) await review(sessionId); };
const paused = (sessionId: string) => manager.getAutomatedApprovalPauseReason(sessionId);

describe("reviewer breaker of a template run (3 consecutive or 20 per turn, per stage session)", () => {
  it("three blocks in one stage session pause that session only", async () => {
    link("plan-session", "plan");
    link("build-session", "build");
    await block("plan-session", 3);
    expect(paused("plan-session")).toBe("consecutive");
    expect(paused("build-session")).toBeUndefined();
    expect(paused(ITEM)).toBeUndefined();
  });

  it("a sibling stage session keeps its own count", async () => {
    link("plan-session", "plan");
    link("build-session", "build");
    await block("plan-session", 2);
    await block("build-session", 2);
    // Four blocks on the row, two in each stage: neither stage has three.
    expect(paused("plan-session")).toBeUndefined();
    expect(paused("build-session")).toBeUndefined();
    await block("build-session", 1);
    expect(paused("build-session")).toBe("consecutive");
    expect(paused("plan-session")).toBeUndefined();
  });

  it("twenty blocks in one stage session's turn pause that session only, though never three in a row", async () => {
    link("plan-session", "plan");
    link("build-session", "build");
    // Two blocks, then an allowed call that ends the run of consecutive ones: ten times.
    for (let round = 0; round < 10; round += 1) {
      expect(paused("plan-session")).toBeUndefined();
      await block("plan-session", 2);
      level = "low";
      await review("plan-session");
      level = "high";
    }
    expect(paused("plan-session")).toBe("total");
    expect(manager.getJudgeBreaker().snapshot("plan-session")).toMatchObject({ total: 20, open: true });
    expect(paused("build-session")).toBeUndefined();
    expect(paused(ITEM)).toBeUndefined();
  });

  it("a non-run child still counts on its root", async () => {
    await block("chat-child-a", 2);
    await block("chat-child-b", 1);
    expect(paused("chat-child-a")).toBe("consecutive");
    expect(paused("chat-child-b")).toBe("consecutive");
    expect(paused("chat-root")).toBe("consecutive");
    // A child of the board row that no run linked keeps the row's shared count, as before.
    await block("unlinked-session", 3);
    expect(paused(ITEM)).toBe("consecutive");
  });

  it("a tripped stage breaker asks a person and, with nobody there, denies with the pause named", async () => {
    link("plan-session", "plan");
    link("scheduled-session", "report", "unattended");
    await block("plan-session", 2);
    const tripping = await review("plan-session");
    expect(tripping.judge).toMatchObject({ judged: true, source: "breaker", decision: "ask", breakerTripped: true, pause: "consecutive" });
    const attended = await review("plan-session");
    expect(attended.judge).toMatchObject({ judged: true, source: "breaker", decision: "ask", pause: "consecutive", rationale: "Automated approval paused: 3 consecutive classifier blocks" });
    // The pipeline sends the rest of that stage's turn to a card, and denies when nobody can answer one.
    const write = (headless: boolean) => manager.checkDetailed("write_probe", "builtin", "write", undefined, { sessionId: "plan-session", trustOrigin: "llm-tool-arg", headless });
    expect(write(false)).toMatchObject({ decision: "ask", reasonCode: "automation-paused" });
    expect(write(true)).toMatchObject({ decision: "deny", reasonCode: "no-approver", reason: NO_APPROVER_MESSAGE });
    expect(write(true).pipelineRequest?.automationPause).toMatchObject({ kind: "consecutive" });

    // A schedule-started stage session has its own breaker; open, it denies and names the pause.
    for (let index = 0; index < 3; index += 1) await review("scheduled-session", "headless");
    expect(paused("scheduled-session")).toBe("consecutive");
    const unattended = await review("scheduled-session", "headless");
    expect(unattended.judge).toMatchObject({ judged: true, source: "breaker", decision: "deny", pause: "consecutive" });
  });

  it("a stage session's count starts at its link, survives a repeated link and is forgotten when the session ends", async () => {
    link("plan-session", "plan");
    await block("plan-session", 3);
    link("plan-session", "plan");
    expect(paused("plan-session")).toBe("consecutive");
    hooks.sessionEnded("plan-session");
    expect(manager.getJudgeBreaker().snapshot("plan-session")).toEqual({ consecutive: 0, total: 0, open: false });
    // The row's shared count never saw the stage's blocks.
    expect(manager.getJudgeBreaker().snapshot(ITEM)).toEqual({ consecutive: 0, total: 0, open: false });
  });
});
