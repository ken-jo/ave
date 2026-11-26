import { mkdtempSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { partialWindowsAsrt } from "../../__tests__/support/host-shell-sandbox-fixtures.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { reviewerJudgeOutcomeForTest } from "../../__tests__/support/reviewer-judge.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { noteToolResultsReturnedToModel, runWithHostTerminalTurn } from "../../tools/host-terminal-turn.js";
import type { HostTerminalCommandScope } from "../../tools/terminal-run.js";
import { issueHostTerminalWriteAuthority } from "../host-terminal-write-authority.js";
import { PermissionManager } from "../permission-manager.js";
import { __resetRunGrantsForTest, registerRunSession } from "../run-grants.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan } from "../sandbox-capability.js";

const ORIGINAL_PLATFORM = process.platform;
const COMMAND = "printf ready";
const EXACT_RULE = { pattern: `Bash(${COMMAND})`, action: "allow" as const };
const OTHER_RULE = "Bash(printf example)";
const SOURCES = ["ordinary card", "forced card", "floor waiver", "exact rule", "reviewed exact rule"] as const;
type Source = typeof SOURCES[number];

let directory: string;
let permissionsFile: string;
let manager: PermissionManager;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-terminal-write-")));
  permissionsFile = join(directory, "permissions.json");
  manager = new PermissionManager(permissionsFile);
  partialWindowsAsrt();
  setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: directory, sid: "S-1-5-21-1" });
});

afterEach(async () => {
  setProcessPlatform(ORIGINAL_PLATFORM);
  _resetAveHomePrivacyForTest();
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetRunGrantsForTest();
  await cleanupTmpDir(directory);
});

async function withAuthority(source: Source, test: (refusal: () => string | undefined, changeBackend: () => void) => Promise<void> | void) {
  const scope: HostTerminalCommandScope = {
    kind: "terminal-command", lane: "manual", commandSha256: "a".repeat(64), tabId: "terminal-tab",
    terminalSessionId: "terminal-instance", sessionId: "alice", turnId: "typed-turn", shell: "zsh",
    cwd: directory, physicalCwd: directory, cwdDevice: "1", cwdInode: "2", controlGeneration: 1, cwdForMatch: directory,
  };
  const reviewed = source === "reviewed exact rule";
  const exact = source === "ordinary card" || source === "exact rule" || reviewed;
  if (exact) await manager.addRulePersist(EXACT_RULE, { kind: "user" });
  await manager.addRulePersist({ pattern: OTHER_RULE, action: "allow" }, { kind: "user" });
  await manager.addRulePersist({ pattern: "Bash(printf blocked)", action: "deny" }, { kind: "user" });
  if (source === "floor waiver") manager.addFloorSessionGrant("alice", { code: "sandbox-unavailable" });
  manager.setUserOwnedSurfaceChoice("alice", "host-terminal", reviewed ? "auto" : source === "ordinary card" ? "ask" : "allow");
  await manager.ensurePermissionRulesLoaded(directory);
  const plan = getHostShellExecutionPlan("host");
  const check = () => manager.areLoadedPermissionRulesCurrent(directory)
    ? manager.checkDetailed("terminal_run", "builtin", "shell", undefined, {
        sessionId: "alice", trustOrigin: "llm-tool-arg", hostTerminalTurn: scope,
        hostShellExecutionPlan: plan, ruleSubject: { kind: "shell", dialect: "bash", command: COMMAND, cwd: directory },
        projectRulesCwd: directory, shellExecution: { runsSandboxed: false },
      })
    : { decision: "deny" as const, reason: "Permission rules changed before typing." };
  await runWithHostTerminalTurn({ sessionId: scope.sessionId, turnId: scope.turnId }, async () => {
    const fresh = check();
    const settled = reviewed ? manager.resolveReviewedPermission(fresh, {
      verdict: { level: "low", reason: "The action matches the request." }, outcome: "fresh", cacheReason: "miss-not-found",
      judge: reviewerJudgeOutcomeForTest("allow", "The action matches the request."),
    }) : fresh;
    expect("reasonCode" in settled && settled.reasonCode).toBe({
      "ordinary card": "user-owned-surface-ask", "forced card": "sandbox-unavailable",
      "floor waiver": "floor-session-allow", "exact rule": "exact-host-rule", "reviewed exact rule": "exact-host-rule",
    }[source]);
    let backend = plan.identity;
    const authority = issueHostTerminalWriteAuthority({
      manager, settled, human: settled.decision === "ask", cardForced: "forceModal" in settled && settled.forceModal === true, reviewed,
      decidedBackend: backend, check, backendIdentity: () => backend,
    });
    await test(authority.refusal, () => { backend = "different host plan"; });
  });
}

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

describe.each(SOURCES)("terminal authority from %s", (source) => {
  it("stands across conversation and run allow changes", () => withAuthority(source, (refusal) => {
    expect(refusal()).toBeUndefined();
    for (const session of ["alice", "bob"]) {
      manager.addSessionRule(session, OTHER_RULE);
      expect(refusal()).toBeUndefined();
    }
    registerRunSession("example", "bob", { stageId: "example", stageName: "Example", lane: "attended" });
    manager.addRunRule("bob", OTHER_RULE);
    expect(refusal()).toBeUndefined();
    expect(manager.endRun("example")).toBe(true);
    expect(refusal()).toBeUndefined();
  }));

  it.each([
    ["a deny was added", () => manager.addRulePersist({ ...EXACT_RULE, action: "deny" }, { kind: "user" })],
    ["an unrelated deny was removed", () => manager.removeRulePersist({ pattern: "Bash(printf blocked)", action: "deny" }, { kind: "user" })],
    ["an unrelated allow was removed", () => manager.removeRulePersist({ pattern: OTHER_RULE, action: "allow" }, { kind: "user" })],
    ["an unrelated allow was saved", () => manager.addRulePersist({ pattern: "Bash(printf bob)", action: "allow" }, { kind: "user" })],
    ["the permission mode changed", () => manager.setMode("allow")],
    ["an unrelated conversation gained a floor waiver", () => manager.addFloorSessionGrant("bob", { code: "sandbox-unavailable" })],
    ["an unrelated conversation ended", () => { manager.addSessionRule("bob", OTHER_RULE); manager.endSession("bob"); }],
    ["the rules file was deleted", () => unlinkSync(permissionsFile)],
    ["external content changed the floor", () => noteToolResultsReturnedToModel()],
  ] as const)("refuses when %s", (_label, change) => withAuthority(source, async (refusal) => {
    await change();
    expect(refusal()).toEqual(expect.any(String));
  }));

  it("refuses when the command's backend changes", () => withAuthority(source, (refusal, changeBackend) => {
    changeBackend();
    expect(refusal()).toEqual(expect.any(String));
  }));

  it("requires the same surface choice only for an automatic allow", () => withAuthority(source, (refusal) => {
    manager.setUserOwnedSurfaceChoice("alice", "host-terminal", source === "ordinary card" ? "allow" : "ask");
    if (source.endsWith("card")) expect(refusal()).toBeUndefined();
    else expect(refusal()).toEqual(expect.any(String));
  }));
});

it.each(["ordinary card", "reviewed exact rule"] as const)("keeps only the person's answer when automation pauses after a %s", (source) =>
  withAuthority(source, (refusal) => {
    if (source === "ordinary card") manager.setUserOwnedSurfaceChoice("alice", "host-terminal", "auto");
    for (let index = 0; index < 3; index++) manager.getJudgeBreaker().record("alice", "ask", `another-call-${index}`);
    expect(manager.isAutomatedApprovalPaused("alice")).toBe(true);
    if (source === "ordinary card") expect(refusal()).toBeUndefined();
    else expect(refusal()).toEqual(expect.any(String));
  }));
